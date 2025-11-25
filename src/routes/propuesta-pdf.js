// src/routes/propuesta.js (individual + todas + from-csv; páginas por carrera)
import express from "express";
import { getRedisClient } from "../redisClient.js";
import PDFDocument from "pdfkit";
import path from "path";
import archiver from "archiver";
import { get } from "http";

const router = express.Router();

const KEY_PROFESORES = "chronos:profesores";
const KEY_HORARIOS = "chronos:horarios";
const KEY_MATERIAS = "chronos:materias";

// (Rutas locales, opcionales: no se usan directamente, dejamos por compatibilidad)
const LOGO_LEFT_PATH = path.resolve(
  process.cwd(),
  "assets/images/logo-unam.png"
);
const LOGO_RIGHT_PATH = path.resolve(
  process.cwd(),
  "assets/images/logo-fes-aragon.png"
);

/* ================= Utilidades comunes (parse/format) ================= */
const pad2 = (n) => String(n ?? "").padStart(2, "0");
const toInt = (v, def = 0) => {
  if (v === null || v === undefined) return def;
  if (typeof v === "number") return Number.isFinite(v) ? v : def;
  const s = String(v).trim();
  if (!s || s === "-") return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
};

const tryParse = (s) => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

function multiLineCell(doc, txt, x, y, w, h, opts = {}) {
  const {
    maxFont = 8,   // tamaño normal
    minFont = 6,   // tamaño mínimo
    font = "Helvetica",
    color = C.text,
    align = "center",
  } = opts;

  const text = String(txt ?? "");

  // Probar con fuente desde maxFont hacia abajo
  let chosenSize = maxFont;
  let textHeight = 0;

  for (let size = maxFont; size >= minFont; size--) {
    doc.font(font).fontSize(size);
    const hStr = doc.heightOfString(text, {
      width: w - 6,
      align,
    });

    // Deja un pequeño margen dentro de la celda
    if (hStr <= h - 4) {
      chosenSize = size;
      textHeight = hStr;
      break;
    }

    // Si nunca cabe, nos quedamos con el más pequeño
    if (size === minFont) {
      chosenSize = size;
      textHeight = hStr;
    }
  }

  const ty = y + (h - textHeight) / 2; // centrar verticalmente

  doc
    .font(font)
    .fontSize(chosenSize)
    .fillColor(color)
    .text(text, x + 3, ty, {
      width: w - 6,
      align,
    });
}


// 🔹 nueva: normaliza la clave a 4 dígitos con ceros a la izquierda
function normalizeCve(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length >= 4) return raw;
  return raw.padStart(4, "0");
}

async function readJsonArray(client, key) {
  // 1) Intentar como string JSON directo
  try {
    const asString = await client.get(key);
    if (asString !== undefined) {
      if (asString === null) return [];
      const val = tryParse(asString);
      if (Array.isArray(val)) return val;
      if (val && typeof val === "object" && Array.isArray(val.data))
        return val.data;
      return [val];
    }
  } catch {}

  // 2) Detectar tipo real
  const t = await client.type(key);
  switch (t) {
    case "list": {
      const arr = await client.lRange(key, 0, -1);
      return arr.map(tryParse).flatMap((v) => (Array.isArray(v) ? v : [v]));
    }
    case "set": {
      const arr = await client.sMembers(key);
      return arr.map(tryParse).flatMap((v) => (Array.isArray(v) ? v : [v]));
    }
    case "hash": {
      const h = await client.hGetAll(key);
      const vals = Object.values(h).map(tryParse);
      return vals.flatMap((v) => (Array.isArray(v) ? v : [v]));
    }
    default: {
      try {
        const raw = await client.sendCommand(["JSON.GET", key, "."]);
        if (raw) {
          const val = JSON.parse(raw);
          if (Array.isArray(val)) return val;
          if (val && typeof val === "object" && Array.isArray(val.data))
            return val.data;
          return [val];
        }
      } catch {}
      return [];
    }
  }
}

// años tipo "23" -> 2023; "18" -> 2018
const normalizeYear = (a) => {
  const y = toInt(a, 0);
  if (y >= 1900) return y;
  if (y >= 0 && y <= 79) return 2000 + y; // 00..79 -> 2000..2079
  if (y >= 80 && y <= 99) return 1900 + y; // 80..99 -> 1980..1999
  return 2000; // fallback
};

// Determina periodo "YYYY-I" (ene–jun) o "YYYY-II" (jul–dic)
function inferPeriodo({ diaIni, mesIni, anoIni, diaFin, mesFin, anoFin }) {
  let y = normalizeYear(anoFin ?? anoIni);
  let m = toInt(mesFin ?? mesIni, 1);
  const tramo = m >= 1 && m <= 6 ? "I" : "II";
  return `${y}-${tramo}`;
}

// Mayor frecuencia de un campo no vacío
function mostFrequentNonEmpty(values = []) {
  const freq = new Map();
  for (const v of values) {
    const s = (v ?? "").toString().trim();
    if (!s || s === "-") continue;
    freq.set(s, (freq.get(s) || 0) + 1);
  }
  let best = "",
    bestCount = -1;
  for (const [k, c] of freq.entries()) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best || "";
}

// Mapear una fila de horario -> row PDF (Redis)
function horarioToRow(h) {
  const iD = pad2(h.diaIni);
  const iM = pad2(h.mesIni);
  const iA = pad2(h.anoIni);

  const tD = pad2(h.diaFin);
  const tM = pad2(h.mesFin);
  const tA = pad2(h.anoFin);

  const teo = toInt(h.horasTeoricas);
  const pra = toInt(h.horasPracticas);
  const tot = toInt(h.horasTotal, teo + pra);

  return {
    mov: (h.tipo ?? "").toString().trim() || "A",
    causa: (h.causa ?? "").toString().trim() || "",
    cat: (h.categoria ?? "").toString().trim() || "",
    iD,
    iM,
    iA,
    tD,
    tM,
    tA,
    plan: String(h.planEstudios ?? ""),
    // 🔹 ahora soporta cveAsignatura o claveAsignatura y rellena a 4 dígitos
    cve: normalizeCve(h.cveAsignatura ?? h.claveAsignatura),
    asig: (h.nombreAsignatura ?? "").toString().trim(),
    grupo: String(h.grupo ?? ""),
    teo,
    pra,
    tot,
    hor: (h.horario ?? "").toString().trim(),
    salon: (h.salon ?? "").toString().trim(),
  };
}

/* ================= Dibujo PDF (compartido) ================= */
const PAGE = { w: 841.89, h: 595.28 };
const MARGIN = 22;
const INNER_W = PAGE.w - MARGIN * 2;
const C = {
  text: "#1A1A1A",
  blue: "#CCD9EA",
  blueDark: "#7E9BC0",
  gray: "#E5EAF0",
  line: "#C7CFD6",
};
const F = { h1: 16, h2: 12, small: 8, base: 9 };

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

async function fetchAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
const LOGO_LEFT_URL =
  process.env.LOGO_LEFT_URL ||
  "https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Escudo-UNAM-escalable.svg/480px-Escudo-UNAM-escalable.svg.png";
const LOGO_RIGHT_URL =
  process.env.LOGO_RIGHT_URL ||
  "https://www.aragon.unam.mx/teotihuacan/src/images/logos/fes-aragon.png";
let LEFT_LOGO_BUF = null,
  RIGHT_LOGO_BUF = null;

function drawHeader(doc, { periodo = "2024-I" } = {}) {
  const top = 32;
  const logoBox = { w: 90, h: 90 };
  const SLOT_W = 160;
  const leftSlotX = MARGIN;
  const rightSlotX = PAGE.w - MARGIN - SLOT_W;
  const leftX = leftSlotX + (SLOT_W - logoBox.w) / 2;
  const rightX = rightSlotX + (SLOT_W - logoBox.w) / 2;
  try {
    if (LEFT_LOGO_BUF)
      doc.image(LEFT_LOGO_BUF, leftX, top, { fit: [logoBox.w, logoBox.h] });
  } catch {}
  try {
    if (RIGHT_LOGO_BUF)
      doc.image(RIGHT_LOGO_BUF, rightX, top, { fit: [logoBox.w, logoBox.h] });
  } catch {}
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
  center(`PERIODO ESCOLAR ${periodo}`, F.h2);
  return top + logoBox.h + 24;
}

function drawInfoBar(
  doc,
  y,
  {
    carrera = "INGENIERIA EN COMPUTACION",
    unidad = "DIVISION DE CIENCIAS FISICO MATEMATICAS Y LAS INGENIERIAS",
  } = {}
) {
  const h = 18;
  const colLeftW = INNER_W * 0.5;
  const x = MARGIN;
  doc.save().rect(x, y, INNER_W, h).fill(C.blue).restore();
  line(doc, x, y, x + INNER_W, y, C.blueDark);
  line(doc, x, y + h, x + INNER_W, y + h, C.blueDark);
  line(doc, x, y, x, y + h, C.blueDark);
  line(doc, x + INNER_W, y, x + INNER_W, y + h, C.blueDark);
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

function drawTable(doc, y, rows) {
  const boxX = MARGIN;
  const boxW = INNER_W;
  const xStart = boxX;
  const baseCols = [
    { key: "mov", w: 36, title: "Mov." },
    { key: "causa", w: 60, title: "Causa" },
    { key: "cat", w: 52, title: "Categoria" },
    { key: "iD", w: 22, title: "D", group: "INICIO" },
    { key: "iM", w: 22, title: "M", group: "INICIO" },
    { key: "iA", w: 32, title: "A", group: "INICIO" },
    { key: "tD", w: 22, title: "D", group: "TERMINO" },
    { key: "tM", w: 22, title: "M", group: "TERMINO" },
    { key: "tA", w: 32, title: "A", group: "TERMINO" },
    { key: "plan", w: 32, title: "Plan" },
    { key: "cve", w: 36, title: "CVE Asig." },
    { key: "asig", w: 0, title: "Nombre Asignatura / Actividad", flex: true },
    { key: "grupo", w: 32, title: "Grupo" },
    { key: "teo", w: 30, title: "Teo.", group: "HORAS" },
    { key: "pra", w: 30, title: "Prác.", group: "HORAS" },
    { key: "tot", w: 30, title: "Tot.", group: "HORAS" },
    { key: "hor", w: 0, title: "Horario", flex: true },
    { key: "salon", w: 48, title: "Salón" },
  ];
  const hHead1 = 18,
    hHead2 = 18,
    hRow = 22,
    sizeTitle = 8,
    sizeBody = 8;
  const interiorW = boxW;
  const fixedTotal = baseCols
    .filter((c) => !c.flex)
    .reduce((a, c) => a + c.w, 0);
  let remaining = interiorW - fixedTotal;
  const asigMin = 320,
    horMin = 200;
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

  const boxY = y;
  const boxH = hHead1 + hHead2 + hRow * (rows.length + 1);
  doc.save().rect(boxX, boxY, boxW, boxH).fill(C.blue).restore();
  line(doc, boxX, boxY, boxX + boxW, boxY, C.blueDark);
  line(doc, boxX, boxY + boxH, boxX + boxW, boxY + boxH, C.blueDark);
  line(doc, boxX, boxY, boxX, boxY + boxH, C.blueDark);
  line(doc, boxX + boxW, boxY, boxX + boxW, boxY + boxH, C.blueDark);

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

  let yData = y1 + hHead1 + hHead2;
  rows.forEach((r) => {
    doc.save().rect(boxX, yData, boxW, hRow).fill("#F9FBFD").restore();
    cx = xStart;
    for (const c of baseCols) {
      const valRaw = r[c.key] ?? "";

      if (c.key === "cat" || c.key === "asig") {
        // 👉 Categoría y Nombre Asignatura / Actividad: multilínea auto
        multiLineCell(doc, valRaw, cx, yData, c.w, hRow, {
          maxFont: sizeBody,
          minFont: 6,
          align: "center",
        });
      } else {
        // Resto de columnas igual que antes
        const align = "center";
        const val =
          c.key === "hor"
            ? textClamp(doc, valRaw, c.w - 6, "Helvetica", sizeBody)
            : String(valRaw);

        cellText(doc, val, cx, yData, c.w, hRow, {
          size: sizeBody,
          align,
          valign: "middle",
        });
      }

      // Bordes verticales
      line(doc, cx, yData, cx, yData + hRow, C.line, 0.6);
      cx += c.w;
    }

    line(doc, boxX + boxW, yData, boxX + boxW, yData + hRow, C.line, 0.6);
    line(doc, boxX, yData + hRow, boxX + boxW, yData + hRow, C.line, 0.6);
    yData += hRow;
  });

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

function drawObservaciones(doc, y, texto = "") {
  doc
    .font("Helvetica")
    .fontSize(F.small)
    .fillColor(C.text)
    .text("Observaciones:", MARGIN + 6, y);
  const lineY = y + 10;
  line(doc, MARGIN + 90, lineY, MARGIN + INNER_W - 6, lineY);
  return y + 26;
}
function drawFooter(
  doc,
  info = {}
) {
  const FOOTER = { base: 100, dateDy: -24, lemaDy: -11, signGap: 64 };
  const bottom = PAGE.h - MARGIN - FOOTER.base;

  const fechaDefault = `Nezahualcóyotl, Estado de México, a ${getDateString()}`;
  const {
    fecha = fechaDefault,
    interesado = "",
    jefe = "ING. JORGE ARTURO LOPEZ HERNANDEZ",
  } = info || {};

  doc
    .font("Helvetica")
    .fontSize(F.small)
    .fillColor(C.text)
    .text(fecha, MARGIN, bottom + FOOTER.dateDy, {
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
  mk(0, "CONFORMIDAD INTERESADO(A)", interesado || "");
  mk(1, "JEFE DE CARRERA", jefe || "NO DEFINIDOXS");
  mk(2, "SELLO Y FIRMA DE RECIBIDO", "DEPTO. DE PERSONAL");
}


function drawOneProposalPage(
  doc,
  { periodo, carrera, unidad, interesado, jefe, fecha, observaciones, rows }
) {
  let y = drawHeader(doc, { periodo });
  y = drawInfoBar(doc, y, { carrera, unidad });
  y = drawTable(doc, y + 18, rows);
  y = drawObservaciones(doc, y, observaciones);
  drawFooter(doc, { fecha, interesado, jefe });
}

/* ============== Agrupación por carrera (Redis) – helper común ============== */
function groupRowsByCarreraFromRedis({ profByWorker, horByWorker }) {
  // 1) Carreras presentes
  const carrerasProf = profByWorker
    .map((p) => (p.carrera ?? "").trim())
    .filter(Boolean);
  const carrerasHor = horByWorker
    .map((h) => (h.carrera ?? "").trim())
    .filter(Boolean);
  const carrerasSet = new Set(
    [...carrerasProf, ...carrerasHor].filter(Boolean)
  );

  const defaultCarrera =
    mostFrequentNonEmpty(carrerasProf) ||
    mostFrequentNonEmpty(carrerasHor) ||
    "desconocido";
  if (carrerasSet.size === 0) carrerasSet.add(defaultCarrera);

  // 2) Metadatos por carrera desde profesores
  const metaPorCarrera = {};
  for (const c of carrerasSet) {
    const subProf = profByWorker.filter((p) => (p.carrera ?? "").trim() === c);
    metaPorCarrera[c] = {
      carrera: c,
      unidad: mostFrequentNonEmpty(subProf.map((p) => p.unidad)),
      jefe: mostFrequentNonEmpty(subProf.map((p) => p.jefe)),
      obs: mostFrequentNonEmpty(subProf.map((p) => p.observaciones)),
    };
  }

  // 3) Bucket de filas por carrera
  const buckets = new Map(); // carrera -> rows[]
  const put = (c, row) => {
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c).push(row);
  };

  // Horarios con carrera específica (o default si viene vacía)
  for (const h of horByWorker) {
    const row = horarioToRow(h);
    const c = (h.carrera ?? "").trim() || defaultCarrera;
    put(c, row);
  }

  // 4) Si no hubo horarios, arma una fila por carrera (plantilla desde profesor)
  if (horByWorker.length === 0 && profByWorker.length) {
    for (const c of carrerasSet) {
      const p =
        profByWorker.find((pp) => (pp.carrera ?? "").trim() === c) ||
        profByWorker[0];
      const teo = toInt(p.horasTeoricas);
      const pra = toInt(p.horasPracticas);
      const tot = toInt(p.horasTotal, teo + pra);
      put(c, {
        mov: p.tipo ?? "A",
        causa: (p.causa ?? "") + "",
        cat: (p.categoria ?? "") + "",
        iD: pad2(p.diaIni),
        iM: pad2(p.mesIni),
        iA: pad2(p.anoIni),
        tD: pad2(p.diaFin),
        tM: pad2(p.mesFin),
        tA: pad2(p.anoFin),
        plan: String(p.planEstudios ?? ""),
        // 🔹 también normalizamos CVE en este caso
        cve: normalizeCve(p.cveAsignatura ?? p.claveAsignatura),
        asig: (p.nombreAsignatura ?? "") + "",
        grupo: String(p.grupo ?? ""),
        teo,
        pra,
        tot,
        hor: (p.horario ?? "") + "",
        salon: (p.salon ?? "") + "",
      });
    }
  }

  // 5) Construcción de páginas (una por carrera)
  const outPages = [];
  for (const [carrera, rows] of buckets.entries()) {
    let periodo = "2024-I";
    const forPeriodo = horByWorker.find((h) => h.anoIni || h.anoFin);
    if (forPeriodo) periodo = inferPeriodo(forPeriodo);

    const meta = metaPorCarrera[carrera] || {
      carrera,
      unidad: "",
      jefe: "",
      obs: "",
    };

    const obsRows = horByWorker
      .filter((h) => ((h.carrera ?? "").trim() || defaultCarrera) === carrera)
      .map((h) => h.observaciones);

    const observaciones = mostFrequentNonEmpty(obsRows) || meta.obs || "";

    outPages.push({
      periodo,
      carrera,
      unidad:
        meta.unidad ||
        "DIVISIÓN DE CIENCIAS FÍSICO MATEMÁTICAS Y LAS INGENIERÍAS",
      jefe: meta.jefe || "ING. JORGE ARTURO LOPEZ HERNANDEZ",
      observaciones,
      rows,
    });
  }
  outPages.sort((a, b) => a.carrera.localeCompare(b.carrera, "es"));
  return outPages;
}

/* ================= Endpoints ================= */

// GET /api/propuesta?worker=809328 – genera UNA propuesta (PDF) para un numTrabajador
router.get("/propuesta", async (req, res) => {
  const worker = req.query.worker || req.query.numTrabajador;
  if (!worker)
    return res.status(400).json({ error: "Falta parámetro ?worker" });

  let client;
  try {
    client = getRedisClient();
  } catch (err) {
    console.error("❌ Redis client no inicializado:", err);
    return res.status(500).json({ error: "Redis no inicializado" });
  }

  try {
    const [profesores, horarios] = await Promise.all([
      readJsonArray(client, KEY_PROFESORES),
      readJsonArray(client, KEY_HORARIOS),
    ]);

    const workerNum = toInt(worker);
    const profByWorker = profesores.filter(
      (p) => toInt(p.numTrabajador) === workerNum
    );
    const horByWorker = horarios.filter(
      (h) => toInt(h.numTrabajador) === workerNum
    );

    if (!profByWorker.length && !horByWorker.length) {
      return res
        .status(404)
        .json({ error: `No hay datos para numTrabajador=${workerNum}` });
    }

    // Cargar logos remotos una vez
    try {
      [LEFT_LOGO_BUF, RIGHT_LOGO_BUF] = await Promise.all([
        fetchAsBuffer(LOGO_LEFT_URL).catch(() => null),
        fetchAsBuffer(LOGO_RIGHT_URL).catch(() => null),
      ]);
    } catch {}

    // Stream de propuesta(s)
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="Propuesta-${workerNum}.pdf"`
    );

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: MARGIN,
    });
    doc.pipe(res);

    const pages = groupRowsByCarreraFromRedis({ profByWorker, horByWorker });

    const interesado =
      mostFrequentNonEmpty([
        ...profByWorker.map((p) => p.profesor),
        ...horByWorker.map((h) => h.profesor),
      ]) || `Trabajador ${workerNum}`;

    pages.forEach((pg, idx) => {
      if (idx > 0) doc.addPage();
      let y = drawHeader(doc, { periodo: pg.periodo });
      y = drawInfoBar(doc, y, { carrera: pg.carrera, unidad: pg.unidad });
      y = drawTable(doc, y + 18, pg.rows);
      y = drawObservaciones(doc, y, pg.observaciones);
      drawFooter(doc, {
        //fecha: "Nezahualcóyotl, Estado de México, a 23 de Noviembre del 2023",
        interesado,
        jefe: pg.jefe,
      });
    });

    doc.end();
  } catch (err) {
    console.error("❌ Error en /propuesta:", err);
    return res.status(500).json({ error: "Error procesando propuesta" });
  }
});

/* ================== /api/propuestas-all (TODOS en un solo PDF) ================== */
// Dibuja 1+ páginas por profesor (una por carrera)
router.get("/propuestas-all", async (req, res) => {
  let client;
  try {
    client = getRedisClient();
  } catch (err) {
    return res.status(500).json({ error: "Redis no inicializado" });
  }

  try {
    const [profesores, horarios] = await Promise.all([
      readJsonArray(client, KEY_PROFESORES),
      readJsonArray(client, KEY_HORARIOS),
    ]);

    // Conjunto de trabajadores presentes en cualquiera de los datasets
    const workerSet = new Set([
      ...profesores.map((p) => toInt(p.numTrabajador)).filter(Boolean),
      ...horarios.map((h) => toInt(h.numTrabajador)).filter(Boolean),
    ]);

    if (workerSet.size === 0)
      return res
        .status(404)
        .json({ error: "No hay profesores/horarios para generar propuestas" });

    // Cargar logos una vez
    try {
      [LEFT_LOGO_BUF, RIGHT_LOGO_BUF] = await Promise.all([
        fetchAsBuffer(LOGO_LEFT_URL).catch(() => null),
        fetchAsBuffer(LOGO_RIGHT_URL).catch(() => null),
      ]);
    } catch {}

    // Stream del PDF multi-página
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="Propuestas-todos.pdf"'
    );

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: MARGIN,
    });
    doc.pipe(res);

    const workers = Array.from(workerSet.values());
    workers.sort((a, b) => a - b);

    workers.forEach((workerNum, idx) => {
      const profByWorker = profesores.filter(
        (p) => toInt(p.numTrabajador) === workerNum
      );
      const horByWorker = horarios.filter(
        (h) => toInt(h.numTrabajador) === workerNum
      );

      const pages = groupRowsByCarreraFromRedis({ profByWorker, horByWorker });
      const interesado =
        mostFrequentNonEmpty([
          ...profByWorker.map((p) => p.profesor),
          ...horByWorker.map((h) => h.profesor),
        ]) || `Trabajador ${workerNum}`;

      pages.forEach((pg, pgIdx) => {
        if (idx > 0 || pgIdx > 0) doc.addPage();
        let y = drawHeader(doc, { periodo: pg.periodo });
        y = drawInfoBar(doc, y, { carrera: pg.carrera, unidad: pg.unidad });
        y = drawTable(doc, y + 18, pg.rows);
        y = drawObservaciones(doc, y, pg.observaciones);
        drawFooter(doc, {
          //fecha: "Nezahualcóyotl, Estado de México, a 23 de Noviembre del 2023",
          interesado,
          jefe: pg.jefe,
        });
      });
    });

    doc.end();
  } catch (err) {
    console.error("❌ Error en /propuestas-all:", err);
    return res.status(500).json({ error: "Error generando propuestas" });
  }
});

/* ================== /api/propuestas-from-csv (TODOS desde CSV en un solo PDF/ZIP) ================== */
// Acepta:
//  - text/csv como body crudo
//  - application/json con { csv: "..." }
//  - ?csvUrl=https://... para que el backend descargue el CSV
// CSV esperado (encabezados):
//  numTrabajador,profesor,carrera,unidad,periodo,jefe,fecha,observaciones,
//  tipo,causa,categoria,diaIni,mesIni,anoIni,diaFin,mesFin,anoFin,
//  planEstudios,cveAsignatura,nombreAsignatura,grupo,horasTeoricas,horasPracticas,horasTotal,horario,salon

// Parser CSV que respeta comillas dobles
function parseCSV(text) {
  const rows = [];
  let i = 0,
    field = "",
    record = [],
    inQuotes = false;

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    rows.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } // "" -> "
        else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") pushField();
      else if (ch === "\n") {
        pushField();
        pushRecord();
      } else if (ch === "\r") {
        /* ignore CR */
      } else field += ch;
    }
    i++;
  }
  if (field.length || record.length) {
    pushField();
    pushRecord();
  }
  return rows;
}

// Normaliza encabezados y devuelve objetos por fila, tolerando alias
function rowsFromCSV(csvText) {
  const raw = parseCSV((csvText || "").trim());
  if (!raw.length) return [];
  const headers = raw[0].map((h) => (h ?? "").trim());

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\s\-]+/g, "")
      .replace(/[_]+/g, "");

  const ALIAS = new Map(
    Object.entries({
      numtrabajador: "numTrabajador",
      num_trabajador: "numTrabajador",
      trabajador: "numTrabajador",

      profesor: "profesor",
      interesado: "profesor",
      carrera: "carrera",
      unidad: "unidad",
      jefe: "jefe",
      observaciones: "observaciones",
      periodo: "periodo",

      tipo: "tipo",
      mov: "tipo",
      causa: "causa",
      categoria: "categoria",
      cat: "categoria",

      diaini: "diaIni",
      diainicio: "diaIni",
      diain: "diaIni",
      dia_ini: "diaIni",

      mesini: "mesIni",
      mesinicio: "mesIni",
      mesin: "mesIni",
      mes_ini: "mesIni",

      anoini: "anoIni",
      anioini: "anoIni",
      ano_ini: "anoIni",

      diafin: "diaFin",
      dia_fin: "diaFin",

      mesfin: "mesFin",
      mes_fin: "mesFin",

      anofin: "anoFin",
      aniofin: "anoFin",
      ano_fin: "anoFin",
      anofin_: "anoFin",

      planestudios: "planEstudios",
      plan_estudios: "planEstudios",
      plan: "planEstudios",

      cveasignatura: "cveAsignatura",
      cve_asignatura: "cveAsignatura",
      clave: "cveAsignatura",
      cve: "cveAsignatura",

      nombreasignatura: "nombreAsignatura",
      nombre_asignatura: "nombreAsignatura",
      asignatura: "nombreAsignatura",
      nombre: "nombreAsignatura",
      asig: "nombreAsignatura",

      grupo: "grupo",

      horasteoricas: "horasTeoricas",
      horas_teoricas: "horasTeoricas",
      teo: "horasTeoricas",

      horaspracticas: "horasPracticas",
      horas_practicas: "horasPracticas",
      pra: "horasPracticas",

      horastotal: "horasTotal",
      horas_total: "horasTotal",
      tot: "horasTotal",

      horario: "horario",
      hor: "horario",

      salon: "salon",
      aula: "salon",

      // 🔹 alias cortos tipo encabezados de la tabla (iD/iM/iA/tD/tM/tA)
      id: "diaIni",
      im: "mesIni",
      ia: "anoIni",
      td: "diaFin",
      tm: "mesFin",
      ta: "anoFin",
    })
  );

  const canonicalHeaders = headers.map((h) => {
    const n = norm(h);
    return ALIAS.get(n) || h;
  });

  const out = [];
  for (let r = 1; r < raw.length; r++) {
    const rec = raw[r];
    if (!rec || rec.every((v) => String(v ?? "").trim() === "")) continue;

    const row = {};
    for (let c = 0; c < canonicalHeaders.length; c++) {
      const key = canonicalHeaders[c];
      row[key] = rec[c] ?? "";
    }
    out.push(row);
  }
  return out;
}

function getDateString(){
    //fecha en formato 23 de Noviembre del 2023
    //numero de dia 2 digitos, mes en letras y anio 4 digitos
    const fecha = new Date();
    const dia = String(fecha.getDate()).padStart(2, '0');
    const mes = fecha.toLocaleString('es-ES', { month: 'long' });
    const anio = fecha.getFullYear();
    return `${dia} de ${mes.charAt(0).toUpperCase() + mes.slice(1)} del ${anio}`;

}

// Devuelve la fila formateada para la tabla, tolerando columnas alias (CSV)
function rowCsvToHorarioRow(csvRow) {
  const first = (...keys) => {
    for (const k of keys) {
      const v = csvRow?.[k];
      if (
        v !== undefined &&
        v !== null &&
        String(v).trim() !== "" &&
        String(v).trim() !== "-"
      ) {
        return v;
      }
    }
    return "";
  };

  const mov = first("tipo", "mov") || "A";
  const cat = first("categoria", "cat");
  const causa = first("causa");

  const iD = pad2(first("diaIni", "dia_ini", "diaini", "diainicio"));
  const iM = pad2(first("mesIni", "mes_ini", "mesini", "mesinicio"));
  const iA = pad2(first("anoIni", "anioIni", "ano_ini", "anoini"));

  const tD = pad2(first("diaFin", "dia_fin"));
  const tM = pad2(first("mesFin", "mes_fin"));
  const tA = pad2(first("anoFin", "anioFin", "ano_fin", "anofin"));

  const plan = String(first("planEstudios", "plan_estudios", "plan") || "");

  // 🔹 CVE desde CSV: se normaliza a 4 dígitos
  const cveRaw = first("cveAsignatura", "cve_asignatura", "clave", "cve");
  const cve = normalizeCve(cveRaw);

  const asig = first(
    "nombreAsignatura",
    "nombre_asignatura",
    "asignatura",
    "nombre",
    "asig"
  );
  const grupo = String(first("grupo") || "");
  const teoN = toInt(first("horasTeoricas", "horas_teoricas", "teo"));
  const praN = toInt(first("horasPracticas", "horas_practicas", "pra"));
  const totN = toInt(first("horasTotal", "horas_total", "tot"), teoN + praN);
  const hor = first("horario", "hor");
  const salon = first("salon", "aula");

  return {
    mov,
    causa,
    cat,
    iD,
    iM,
    iA,
    tD,
    tM,
    tA,
    plan,
    cve,
    asig,
    grupo,
    teo: teoN,
    pra: praN,
    tot: totN,
    hor,
    salon,
  };
}

// Construye páginas (por carrera) a partir de las filas CSV de UN trabajador
function buildPagesFromCsvRecords(recs, worker) {
  // Agrupar por carrera
  const byCarrera = new Map();
  for (const r of recs) {
    const c = String(r.carrera ?? "").trim() || "desconocido";
    if (!byCarrera.has(c)) byCarrera.set(c, []);
    byCarrera.get(c).push(r);
  }

  const interesado =
    mostFrequentNonEmpty(recs.map((r) => r.profesor)) || `Trabajador ${worker}`;

  const carrerasOrden = Array.from(byCarrera.keys()).sort((a, b) =>
    a.localeCompare(b, "es")
  );

  const pages = carrerasOrden.map((carrera) => {
    const group = byCarrera.get(carrera);

    const unidad =
      mostFrequentNonEmpty(group.map((r) => r.unidad)) ||
      "DIVISIÓN DE CIENCIAS FÍSICO MATEMÁTICAS Y LAS INGENIERÍAS";
    const jefe =
      mostFrequentNonEmpty(group.map((r) => r.jefe)) ||
      "ING. JORGE ARTURO LOPEZ HERNANDEZ";
    const observaciones = mostFrequentNonEmpty(
      group.map((r) => r.observaciones)
    );
    const periodo =
      mostFrequentNonEmpty(group.map((r) => r.periodo)) || "2024-I";

    const rows = group.map(rowCsvToHorarioRow);

    return { carrera, unidad, jefe, observaciones, periodo, rows };
  });

  return { pages, interesado };
}

// Crea un PDF en memoria (Buffer) para UN trabajador (usado cuando isZip = true)
function createPdfBufferForCsvWorker(worker, recs) {
  const { pages, interesado } = buildPagesFromCsvRecords(recs, worker);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: MARGIN,
    });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    pages.forEach((pg, pgIdx) => {
      if (pgIdx > 0) doc.addPage();
      let y = drawHeader(doc, { periodo: pg.periodo });
      y = drawInfoBar(doc, y, { carrera: pg.carrera, unidad: pg.unidad });
      y = drawTable(doc, y + 18, pg.rows);
      y = drawObservaciones(doc, y, pg.observaciones);
      drawFooter(doc, {
        interesado,
        jefe: pg.jefe,
        // fecha: usamos la default del pie
      });
    });

    doc.end();
  });
}

// Genera nombre de archivo para el ZIP: "Profesor - 123456.pdf"
function buildWorkerPdfFileName(interesado, worker) {
  const clean = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_\- ]/g, "")
      .trim();

  const profName = clean(interesado || "Trabajador");
  const workerId = clean(worker || "");
  return `${profName} - ${workerId || "sin-numero"}.pdf`;
}

// Ejemplo de CSV para descargar desde el front
router.get("/example-csv", (req, res) => {
  const EXAMPLE_CSV_ROUTE = "./src/assets/examples/example.csv";
  res.download(path.resolve(process.cwd(), EXAMPLE_CSV_ROUTE));
});

router.post("/propuestas-from-csv", async (req, res) => {
  try {
    // 1) Obtener el texto CSV
    let csvText = "";
    if (typeof req.body === "string" && req.body.trim().includes(",")) {
      // text/csv crudo
      csvText = req.body;
    } else if (req.body && typeof req.body.csv === "string") {
      // application/json { csv: "..." }
      csvText = req.body.csv;
    } else if (req.query.csvUrl) {
      // ?csvUrl=https://...
      const r = await fetch(String(req.query.csvUrl));
      if (!r.ok)
        return res
          .status(400)
          .json({ error: `No se pudo descargar CSV (${r.status})` });
      csvText = await r.text();
    } else {
      return res
        .status(400)
        .json({ error: 'Envía text/csv crudo, {"csv":"..."} o ?csvUrl=' });
    }

    const csvRows = rowsFromCSV(csvText);
    if (!csvRows.length)
      return res.status(400).json({ error: "CSV vacío o inválido" });

    // 2) Agrupar por num_trabajador
    const byWorker = new Map();
    for (const r of csvRows) {
      const worker = String(r.num_trabajador || r.numTrabajador || "").trim();
      if (!worker) continue;
      if (!byWorker.has(worker)) byWorker.set(worker, []);
      byWorker.get(worker).push(r);
    }

    if (byWorker.size === 0)
      return res
        .status(400)
        .json({ error: "El CSV no contiene numTrabajador válidos" });

    // 3) Determinar modo: PDF único vs ZIP (tolerante a varias formas)
    const rawIsZip =
      req.query.isZip ??
      req.query.iszip ??
      req.query.zip ??
      (req.body && (req.body.isZip ?? req.body.zip)) ??
      "false";

    const isZip =
      String(rawIsZip).toLowerCase() === "true" ||
      String(rawIsZip) === "1" ||
      String(rawIsZip).toLowerCase() === "zip";

    // 4) Cargar logos remotos si aún no están
    try {
      if (!LEFT_LOGO_BUF || !RIGHT_LOGO_BUF) {
        [LEFT_LOGO_BUF, RIGHT_LOGO_BUF] = await Promise.all([
          fetchAsBuffer(LOGO_LEFT_URL).catch(() => null),
          fetchAsBuffer(LOGO_RIGHT_URL).catch(() => null),
        ]);
      }
    } catch (e) {
      console.warn("⚠️ No se pudieron cargar logos remotos:", e?.message);
    }

    const workers = Array.from(byWorker.keys()).sort(
      (a, b) => Number(a) - Number(b)
    );

    /* ===================== MODO ZIP: un PDF por profesor ===================== */
    if (isZip) {
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="Propuestas-desde-CSV.zip"'
      );

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        console.error("❌ Error en archiver:", err);
        if (!res.headersSent) {
          res.status(500).end("Error generando ZIP");
        } else {
          res.end();
        }
      });

      archive.pipe(res);

      // Generar PDF por trabajador y añadirlo al ZIP
      for (const worker of workers) {
        const recs = byWorker.get(worker) || [];
        if (!recs.length) continue;

        const { pages, interesado } = buildPagesFromCsvRecords(recs, worker);
        if (!pages.length) continue;

        const pdfBuffer = await createPdfBufferForCsvWorker(worker, recs);
        const filename = buildWorkerPdfFileName(interesado, worker);
        archive.append(pdfBuffer, { name: filename });
      }

      archive.finalize();
      return;
    }

    /* ===================== MODO NORMAL: un solo PDF multi-página ===================== */
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="Propuestas-desde-CSV.pdf"'
    );

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: MARGIN,
    });
    doc.pipe(res);

    workers.forEach((worker, idx) => {
      const recs = byWorker.get(worker) || [];
      const { pages, interesado } = buildPagesFromCsvRecords(recs, worker);

      pages.forEach((pg, pgIdx) => {
        if (idx > 0 || pgIdx > 0) doc.addPage();
        let y = drawHeader(doc, { periodo: pg.periodo });
        y = drawInfoBar(doc, y, { carrera: pg.carrera, unidad: pg.unidad });
        y = drawTable(doc, y + 18, pg.rows);
        y = drawObservaciones(doc, y, pg.observaciones);
        drawFooter(doc, {
          interesado,
          jefe: pg.jefe,
          // fecha: usamos la default del pie
        });
      });
    });

    doc.end();
  } catch (err) {
    console.error("❌ Error en /propuestas-from-csv:", err);
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ error: "Error generando propuestas desde CSV" });
    }
    res.end();
  }
});

export default router;
