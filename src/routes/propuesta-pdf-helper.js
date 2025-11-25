// src/routes/forma-movimientos.js
import express from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const router = express.Router();

/* ========= Config ========= */
const PAGE = { w: 841.89, h: 595.28 }; // A4 horizontal (pt)
const MARGIN = 22;
const INNER_W = PAGE.w - MARGIN * 2;

const C = {
  black: "#000",
  white: "#FFF",
  text: "#1A1A1A",
  gray: "#E5EAF0",
  grayDark: "#AEB7C2",
  blue: "#CCD9EA",
  blueDark: "#7E9BC0",
  line: "#C7CFD6",
};

const F = {
  h1: 16,
  h2: 12,
  h3: 10.5,
  base: 9,
  small: 8,
};

// Offsets del footer para ajustar posiciones rápidamente
const FOOTER = {
  base: 120, // distancia desde el borde inferior (más grande = más arriba)
  dateDy: -6, // ajuste fino para la línea de fecha (negativo = más arriba)
  lemaDy: 8, // distancia desde la fecha hasta el lema
  signGap: 80, // distancia desde lema a las líneas de firma
};


// Rutas absolutas a los logos locales
const LOGO_LEFT_PATH  = path.resolve(process.cwd(), "assets/images/logo-unam.png");
const LOGO_RIGHT_PATH = path.resolve(process.cwd(), "assets/images/logo-fes-aragon.png");



/* ========= Helpers ========= */
function line(doc, x1, y1, x2, y2, color = C.line, w = 0.7) {
  doc
    .save()
    .strokeColor(color)
    .lineWidth(w)
    .moveTo(x1, y1)
    .lineTo(x2, y2)
    .stroke()
    .restore();
}

async function fetchAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function cellText(doc, txt, x, y, w, h, opts = {}) {
  const {
    align = "center",
    valign = "middle",
    font = "Helvetica",
    bold = false,
    size = F.base,
    color = C.text,
  } = opts;
  const ty =
    valign === "top"
      ? y + 3
      : valign === "bottom"
      ? y + h - size - 3
      : y + (h - size) / 2 - 1;

  doc
    .font(bold ? "Helvetica-Bold" : font)
    .fontSize(size)
    .fillColor(color)
    .text(txt ?? "", x + 3, ty, { width: w - 6, align });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function textClamp(doc, txt, maxWidth, font = "Helvetica", size = 9) {
  if (txt == null) return "";
  doc.font(font).fontSize(size);
  let s = String(txt);
  if (doc.widthOfString(s) <= maxWidth) return s;
  // elipsis binaria simple
  let lo = 0,
    hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const candidate = s.slice(0, mid) + "…";
    if (doc.widthOfString(candidate) <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  return s.slice(0, Math.max(0, lo - 1)) + "…";
}

/* ========= Header con (opcional) logos y títulos ========= */
function drawHeader(doc, header = { periodo: "2024-I" }) {
  const top = 32;
  const logoBox = { w: 90, h: 90 };

  // Definimos "slots" laterales para centrar los logos entre el margen y el bloque de títulos
  const SLOT_W = 160; // ancho del slot lateral para cada logo
  const leftSlotX = MARGIN;
  const rightSlotX = PAGE.w - MARGIN - SLOT_W;

  // Calculamos posiciones centradas dentro del slot
  const leftX = leftSlotX + (SLOT_W - logoBox.w) / 2;
  const rightX = rightSlotX + (SLOT_W - logoBox.w) / 2;

  // LOGO izquierdo/derecho
  doc.image(LOGO_LEFT_PATH, leftX, top, { fit: [logoBox.w, logoBox.h] });
  doc.image(LOGO_RIGHT_PATH, rightX, top, { fit: [logoBox.w, logoBox.h] });

  // Bloque de títulos centrado en el ancho útil
  let y = top + 6;
  const center = (t, s, b = true) => {
    doc
      .font(b ? "Helvetica-Bold" : "Helvetica")
      .fontSize(s)
      .fillColor(C.text)
      .text(t, MARGIN, y, { width: INNER_W, align: "center" });
    y += s + 4;
  };

  center("UNIVERSIDAD NACIONAL AUTÓNOMA DE MÉXICO", F.h1);
  center("FACULTAD DE ESTUDIOS SUPERIORES ARAGÓN", F.h2);
  center("FORMA DE MOVIMIENTOS DE PERSONAL ACADÉMICO", F.h2);
  center(`PERIODO ESCOLAR ${header.periodo}`, F.h2);

  return top + logoBox.h + 24;
}

/* ========= Barra superior: carrera / unidad responsable ========= */
function drawInfoBar(
  doc,
  y,
  {
    carrera = "INGENIERIA EN COMPUTACION",
    unidad = "DIVISION DE CIENCIAS FISICO MATEMATICAS Y LAS INGENIERIAS - 0",
  } = {}
) {
  const h = 18;
  const colLeftW = INNER_W * 0.5;
  const x = MARGIN;

  // Franja azul claro con línea exterior
  doc.save().rect(x, y, INNER_W, h).fill(C.blue).restore();
  line(doc, x, y, x + INNER_W, y, C.blueDark);
  line(doc, x, y + h, x + INNER_W, y + h, C.blueDark);
  line(doc, x, y, x, y + h, C.blueDark);
  line(doc, x + INNER_W, y, x + INNER_W, y + h, C.blueDark);

  // Etiquetas
  doc
    .font("Helvetica-Bold")
    .fontSize(F.small)
    .fillColor(C.text)
    .text("CARRERA O ÁREA:", x + 6, y + 6);
  doc
    .font("Helvetica")
    .fontSize(F.small)
    .text(carrera, x + 90, y + 6, { width: colLeftW - 120 });

  const xr = x + colLeftW;
  doc
    .font("Helvetica-Bold")
    .fontSize(F.small)
    .text("UNIDAD RESPONSABLE:", xr + 6, y + 6);
  doc
    .font("Helvetica")
    .fontSize(F.small)
    .text(unidad, xr + 110, y + 6, { width: INNER_W - colLeftW - 110 });

  return y + h + 18;
}

/* ========= Tabla principal (overflow-safe, anchos dinámicos) ========= */
function drawTable(doc, y, rows) {
  // Borde exterior exacto al ancho útil
  const boxX = MARGIN;
  const boxW = INNER_W;
  const xStart = boxX; // sin columnas fantasma (alineado al borde exterior)

  // Columnas base (algunas flex)
  const baseCols = [
    { key: "mov", w: 36, title: "Mov." },
    { key: "causa", w: 60, title: "Causa" },
    { key: "cat", w: 52, title: "Categoria" },

    // INICIO (D M A)
    { key: "iD", w: 22, title: "D", group: "INICIO" },
    { key: "iM", w: 22, title: "M", group: "INICIO" },
    { key: "iA", w: 32, title: "A", group: "INICIO" },

    // TERMINO (D M A)
    { key: "tD", w: 22, title: "D", group: "TERMINO" },
    { key: "tM", w: 22, title: "M", group: "TERMINO" },
    { key: "tA", w: 32, title: "A", group: "TERMINO" },

    { key: "plan", w: 32, title: "Plan" },
    { key: "cve", w: 36, title: "CVE Asig." },

    // FLEX 1
    { key: "asig", w: 0, title: "Nombre Asignatura / Actividad", flex: true },

    { key: "grupo", w: 32, title: "Grupo" },

    // HORAS – grupo y 3 columnas
    { key: "teo", w: 30, title: "Teo.", group: "HORAS" },
    { key: "pra", w: 30, title: "Prác.", group: "HORAS" },
    { key: "tot", w: 30, title: "Tot.", group: "HORAS" },

    // FLEX 2
    { key: "hor", w: 0, title: "Horario", flex: true },

    { key: "salon", w: 48, title: "Salón" },
  ];

  const hHead1 = 18; // grupos
  const hHead2 = 18; // títulos
  const hRow = 22; // datos
  const sizeTitle = 8;
  const sizeBody = 8;

  // Calcular flex (asig/hor) para que sumen exacto a boxW-4
  const interiorW = boxW; // ocupa todo el ancho útil, sin tiras laterales
  const fixedTotal = baseCols
    .filter((c) => !c.flex)
    .reduce((a, c) => a + c.w, 0);
  let remaining = interiorW - fixedTotal;

  const asigMin = 320;
  const horMin = 200;

  let asigW = Math.round(remaining * 0.65);
  let horW = remaining - asigW;

  if (asigW < asigMin || horW < horMin) {
    const totalMin = asigMin + horMin;
    if (remaining <= 0) {
      asigW = asigMin;
      horW = horMin;
    } else if (remaining < totalMin) {
      asigW = clamp(
        Math.round(remaining * (asigMin / totalMin)),
        60,
        remaining - 60
      );
      horW = remaining - asigW;
    } else {
      asigW = Math.max(asigW, asigMin);
      horW = Math.max(horW, horMin);
      const over = asigW + horW - remaining;
      if (over > 0) asigW = Math.max(asigMin, asigW - over);
    }
  }

  baseCols.find((c) => c.key === "asig").w = asigW;
  baseCols.find((c) => c.key === "hor").w = horW;

  // Altura total considerando 1 fila de totales
  const boxY = y;
  const boxH = hHead1 + hHead2 + hRow * (rows.length + 1);

  // Fondo y marco
  doc.save().rect(boxX, boxY, boxW, boxH).fill(C.blue).restore();
  line(doc, boxX, boxY, boxX + boxW, boxY, C.blueDark);
  line(doc, boxX, boxY + boxH, boxX + boxW, boxY + boxH, C.blueDark);
  line(doc, boxX, boxY, boxX, boxY + boxH, C.blueDark);
  line(doc, boxX + boxW, boxY, boxX + boxW, boxY + boxH, C.blueDark);

  // Fila 1: grupos
  let cx = xStart;
  let y1 = boxY;
  for (let i = 0; i < baseCols.length; ) {
    const g = baseCols[i].group;
    let spanW = baseCols[i].w;
    let j = i + 1;
    while (j < baseCols.length && baseCols[j].group === g) {
      spanW += baseCols[j].w;
      j++;
    }
    if (g) {
      cellText(doc, g, cx, y1, spanW, hHead1, { bold: true, size: sizeTitle });
      line(doc, cx, y1 + hHead1, cx + spanW, y1 + hHead1, C.blueDark);
    }
    line(doc, cx, y1, cx, y1 + hHead1, C.blueDark);
    line(doc, cx + spanW, y1, cx + spanW, y1 + hHead1, C.blueDark);
    cx += spanW;
    i = j;
  }

  // Fila 2: títulos
  doc
    .save()
    .rect(boxX, y1 + hHead1, boxW, hHead2)
    .fill(C.gray)
    .restore();
  line(doc, boxX, y1 + hHead1, boxX + boxW, y1 + hHead1, C.blueDark);
  line(
    doc,
    boxX,
    y1 + hHead1 + hHead2,
    boxX + boxW,
    y1 + hHead1 + hHead2,
    C.line
  );

  cx = xStart;
  for (const c of baseCols) {
    cellText(doc, c.title, cx, y1 + hHead1, c.w, hHead2, {
      bold: true,
      size:
        c.key === "asig"
          ? sizeTitle - 1
          : c.key === "cve"
          ? sizeTitle - 2
          : sizeTitle,
      valign: "middle",
    });
    line(doc, cx, y1 + hHead1, cx, y1 + hHead1 + hHead2, C.blueDark);
    cx += c.w;
  }
  line(
    doc,
    boxX + boxW,
    y1 + hHead1,
    boxX + boxW,
    y1 + hHead1 + hHead2,
    C.blueDark
  );

  // Filas de datos
  let yData = y1 + hHead1 + hHead2;
  rows.forEach((r, idx) => {
    doc.save().rect(boxX, yData, boxW, hRow).fill("#F9FBFD").restore();

    cx = xStart;
    for (const c of baseCols) {
      const align =
        c.key === "asig" ? "center" : c.key === "hor" ? "center" : "center";
      const valRaw = r[c.key] ?? "";
      const val =
        c.key === "asig" || c.key === "hor"
          ? textClamp(doc, valRaw, c.w - 6, "Helvetica", sizeBody)
          : String(valRaw);

      cellText(doc, val, cx, yData, c.w, hRow, {
        size: sizeBody,
        align,
        valign: "middle",
      });
      line(doc, cx, yData, cx, yData + hRow, C.line, 0.6);
      cx += c.w;
    }
    line(doc, boxX + boxW, yData, boxX + boxW, yData + hRow, C.line, 0.6);
    line(doc, boxX, yData + hRow, boxX + boxW, yData + hRow, C.line, 0.6);
    yData += hRow;
  });

  // Totales
  const t = rows.reduce(
    (acc, r) => {
      acc.teo += +r.teo || 0;
      acc.pra += +r.pra || 0;
      acc.tot += +r.tot || 0;
      return acc;
    },
    { teo: 0, pra: 0, tot: 0 }
  );

  doc.save().rect(boxX, yData, boxW, hRow).fill(C.gray).restore();

  const idxGrupo = baseCols.findIndex((c) => c.key === "grupo");
  const labelSpan = baseCols.slice(0, idxGrupo).reduce((a, c) => a + c.w, 0);

  cx = xStart;
  cellText(doc, "Totales:", cx, yData, labelSpan, hRow, {
    bold: true,
    align: "right",
  });

  // saltar "Grupo"
  cx = xStart + labelSpan + baseCols[idxGrupo].w;

  const wTeo = baseCols.find((c) => c.key === "teo").w;
  const wPra = baseCols.find((c) => c.key === "pra").w;
  const wTot = baseCols.find((c) => c.key === "tot").w;

  cellText(doc, String(t.teo), cx, yData, wTeo, hRow, { bold: true });
  cx += wTeo;
  cellText(doc, String(t.pra), cx, yData, wPra, hRow, { bold: true });
  cx += wPra;
  cellText(doc, String(t.tot), cx, yData, wTot, hRow, { bold: true });

  line(doc, boxX, yData + hRow, boxX + boxW, yData + hRow, C.line, 0.8);

  return yData + hRow + 10;
}

/* ========= Observaciones y firmas ========= */
function drawObservaciones(doc, y, texto = "") {
  // Etiqueta
  doc
    .font("Helvetica")
    .fontSize(F.small)
    .fillColor(C.text)
    .text("Observaciones:", MARGIN + 6, y);

  // Línea
  const xLineStart = MARGIN + 90;
  const lineY = y + 10;
  line(doc, xLineStart, lineY, MARGIN + INNER_W - 6, lineY);

  // Texto SOBRE la línea (ligeramente arriba para que "asiente" sobre el trazo)
  const xText = xLineStart + 4;
  const wText = MARGIN + INNER_W - 6 - xText;
  const display = textClamp(doc, texto || "", wText, "Helvetica", F.small);
  doc
    .font("Helvetica")
    .fontSize(F.small)
    .fillColor(C.text)
    .text(display, xText, y + 2, {
      width: wText,
      align: "left",
    });

  return y + 26;
}

function drawFooter(
  doc,
  info = {
    fecha: "Nezahualcóyotl, Estado de México, a 23 de Noviembre del 2023",
    interesado: "ABURTO CAMACHO BLANCA PAMELA",
    jefe: "ING. JORGE ARTURO LOPEZ HERNANDEZ",
  }
) {
  const bottom = PAGE.h - MARGIN - FOOTER.base;

  // Ciudad/fecha y lema
  doc
    .font("Helvetica")
    .fontSize(F.small)
    .fillColor(C.text)
    .text(info.fecha, MARGIN, bottom + FOOTER.dateDy, {
      width: INNER_W,
      align: "center",
    });
  doc
    .font("Helvetica-Bold")
    .text("“POR MI RAZA HABLARÁ EL ESPÍRITU”", MARGIN, bottom + FOOTER.lemaDy, {
      width: INNER_W,
      align: "center",
    });

  const y = bottom + FOOTER.signGap;
  const colW = INNER_W / 3;

  const mk = (i, label, name) => {
    const x = MARGIN + i * colW;
    line(doc, x + 30, y, x + colW - 30, y);
    doc
      .font("Helvetica")
      .fontSize(F.small)
      .text(label, x, y + 8, { width: colW, align: "center" });
    doc
      .font("Helvetica")
      .fontSize(F.small)
      .text(name, x, y + 26, { width: colW, align: "center" });
  };

  mk(0, "CONFORMIDAD INTERESADO(A)", "ABURTO CAMACHO BLANCA PAMELA");
  mk(1, "JEFE DE CARRERA", "ING. JORGE ARTURO LOPEZ HERNANDEZ");
  mk(2, "SELLO Y FIRMA DE RECIBIDO", "DEPTO. DE RECURSOS HUMANOS");
}

export async function buildFormaMovimientosPDFBuffer(payload = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const chunks = [];
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margin: MARGIN,
      });

      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Reusar la función anterior, pero sin `res`. Copiamos la lógica mínima:
      const periodo = payload.periodo || "2024-I";
      const carrera = payload.carrera || "INGENIERIA EN COMPUTACION";
      const unidad =
        payload.unidad ||
        "DIVISION DE CIENCIAS FISICO MATEMATICAS Y LAS INGENIERIAS";
      const interesado = payload.interesado || "ABURTO CAMACHO BLANCA PAMELA";
      const jefe = payload.jefe || "ING. JORGE ARTURO LOPEZ HERNANDEZ";
      const fecha =
        payload.fecha ||
        "Nezahualcóyotl, Estado de México, a 23 de Noviembre del 2023";
      const observaciones = payload.observaciones || "";
   

      let y = drawHeader(
        doc,
        { periodo }
      );
      y = drawInfoBar(doc, y, { carrera, unidad });

      const fallbackRows = [
        {
          mov: "A",
          causa: "PRORROGA",
          cat: 'INT "A"',
          iD: "07",
          iM: "08",
          iA: "23",
          tD: "28",
          tM: "01",
          tA: "24",
          plan: "1279",
          cve: "1705",
          asig: "SEGURIDAD INFORMATICA",
          grupo: "2757",
          teo: 4,
          pra: 4,
          tot: 8,
          hor: "LU MI 19:00 - 21:00",
          salon: "A8117",
        },
        {
          mov: "A",
          causa: "ALTA",
          cat: 'INT "A"',
          iD: "08",
          iM: "08",
          iA: "23",
          tD: "30",
          tM: "01",
          tA: "24",
          plan: "1279",
          cve: "1710",
          asig: "BASES DE DATOS",
          grupo: "2810",
          teo: 2,
          pra: 3,
          tot: 5,
          hor: "MA JU 19:00 - 20:30",
          salon: "A8201",
        },
      ];
      const rows = Array.isArray(payload.rows) ? payload.rows : fallbackRows;

      y = drawTable(doc, y + 18, rows);
      y = drawObservaciones(doc, y, observaciones);

      drawFooter(doc, { fecha, interesado, jefe });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ========= Route ========= */
router.post("/forma-movimientos-pdf", async (req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'inline; filename="forma-movimientos.pdf"'
  );

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: MARGIN,
  });
  doc.pipe(res);

  // ===== Body (JSON) con fallback =====
  const b = req.body || {};
  const periodo = b.periodo || "2024-I";
  const carrera = b.carrera || "INGENIERIA EN COMPUTACION";
  const unidad =
    b.unidad || "DIVISION DE CIENCIAS FISICO MATEMATICAS Y LAS INGENIERIAS";
  const interesado = b.interesado || "ABURTO CAMACHO BLANCA PAMELA";
  const jefe = b.jefe || "ING. JORGE ARTURO LOPEZ HERNANDEZ";
  const fecha =
    b.fecha || "Nezahualcóyotl, Estado de México, a 23 de Noviembre del 2023";
  const observaciones = b.observaciones || "";

  const leftUrl = b.logoLeftUrl || LOGO_LEFT_URL;
  const rightUrl = b.logoRightUrl || LOGO_RIGHT_URL;

  // Carga de logos desde URL (opcional)
  /*const [leftLogo, rightLogo] = await Promise.all([
    fetchAsBuffer(leftUrl).catch(() => null),
    fetchAsBuffer(rightUrl).catch(() => null),
  ]);*/

  let y = drawHeader(doc, { periodo });
  y = drawInfoBar(doc, y, { carrera, unidad });

  // Filas de la tabla (si no mandan, usa fallback de ejemplo)
  const fallbackRows = [
    {
      mov: "A",
      causa: "PRORROGA",
      cat: 'INT "A"',
      iD: "07",
      iM: "08",
      iA: "23",
      tD: "28",
      tM: "01",
      tA: "24",
      plan: "1279",
      cve: "1705",
      asig: "SEGURIDAD INFORMATICA",
      grupo: "2757",
      teo: 4,
      pra: 4,
      tot: 8,
      hor: "LU MI 19:00 - 21:00",
      salon: "A8117",
    },
    {
      mov: "A",
      causa: "ALTA",
      cat: 'INT "A"',
      iD: "08",
      iM: "08",
      iA: "23",
      tD: "30",
      tM: "01",
      tA: "24",
      plan: "1279",
      cve: "1710",
      asig: "BASES DE DATOS",
      grupo: "2810",
      teo: 2,
      pra: 3,
      tot: 5,
      hor: "MA JU 19:00 - 20:30",
      salon: "A8201",
    },
  ];
  const rows = Array.isArray(b.rows) ? b.rows : fallbackRows;

  y = drawTable(doc, y + 18, rows);
  y = drawObservaciones(doc, y, observaciones);

  drawFooter(doc, { fecha, interesado, jefe });
  doc.end();
});

export default router;
