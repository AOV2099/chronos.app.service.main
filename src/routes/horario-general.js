import express from "express";
import PDFDocument from "pdfkit";
import { getRedisClient } from "../redisClient.js";

const router = express.Router();

let redisClient = null;
const PROFESORES_KEY = "chronos:profesores";
const HORARIOS_KEY = "chronos:horarios";
let profesores = [];
let horarios = [];

async function fetchHorariosProfesores() {
  try {
    redisClient = getRedisClient();
  } catch (error) {
    console.error("❌ Error al obtener el cliente Redis:", error);
  }

  try {
    if (!redisClient) throw new Error("Redis client not initialized");

    const data = await redisClient.json.get(HORARIOS_KEY);
    const dataProf = await redisClient.json.get(PROFESORES_KEY);
    //console.log(data);
    //console.log(dataProf);

    return { horarios: data || [], profesores: dataProf || [] };
  } catch (error) {
    console.error("❌ Error al obtener los horarios de Redis:", error);
    return { horarios: [], profesores: [] };
  }
}

/** ====== CONFIG ====== */
const PAGE = { w: 841.89, h: 595.28 }; // A4 landscape pt
const MARGIN = 38;
const INNER_W = PAGE.w - 2 * MARGIN;

// Anchos principales
const COL_A_W = 180; // Académico
const COL_C_W = 120; // Carrera (nuevo)
const COL_B_W = 135; // Nombramiento
const RIGHT_W = INNER_W - COL_A_W - COL_C_W - COL_B_W; // = PARCIAL_W + NUMS_W

// Bloque derecho
const PARCIAL_W = 60; // Celda gris PARCIAL/TOTAL
const NUMS_W = RIGHT_W - PARCIAL_W; // 4 columnas (una por semestre)

// Alturas
const BAND_H = 22; // header negro
let ROW_H = 40; // altura base filas (ahora autoajustable)

// Tipografías y tamaños (reducidos)
const TITLE_SIZES = {
  l1: 13,
  l2: 12,
  l3: 10,
  l4: 10,
  l5: 10,
  l6: 10,
};
const TABLE_FONT = {
  header: 9,
  body: 8.5,
  parcial: 9,
  nameTitle: 9.5,
  nameMeta: 8,
  htHp: 8,
};

// Colores
const C = {
  black: "#000000",
  text: "#111111",
  subtle: "#666666",
  line: "#CFCFCF",
  gray: "#E9E9E9",
  white: "#FFFFFF",
  total: "#F5F5F5", // fondo para fila TOTAL
};

// Rutas opcionales para logos (puedes usar variables de entorno o query params)
const LOGO_LEFT_PATH = process.env.LOGO_LEFT_PATH || null;
const LOGO_RIGHT_PATH = process.env.LOGO_RIGHT_PATH || null;
const LOGO_LEFT_URL =
  process.env.LOGO_LEFT_URL ||
  "https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Escudo-UNAM-escalable.svg/1066px-Escudo-UNAM-escalable.svg.png";
const LOGO_RIGHT_URL =
  process.env.LOGO_RIGHT_URL ||
  "https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Escudo-UNAM-escalable.svg/1066px-Escudo-UNAM-escalable.svg.png";

/** ====== UTILS ====== */
function splitEvenInt(total, n) {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  const widths = Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
  return {
    widths,
    xsFrom: (x0) =>
      widths.reduce((acc, w, i) => {
        acc.push(i === 0 ? x0 : acc[i - 1] + widths[i - 1]);
        return acc;
      }, []),
  };
}

function drawTable(doc, cfg) {
  const {
    x,
    y,
    width,
    rows,
    cols,
    colWidths,
    rowHeights,
    rowHeight = 24,
    borderColor = "#000",
    borderWidth = 0.5,
    bgColor = null,
    headerRows = 0,
    headerFill = "#000",
    headerTextColor = "#fff",
    bodyTextColor = "#111",
    cellPadding = 4,
    cells = [],
  } = cfg;

  const cw =
    colWidths && colWidths.length === cols
      ? colWidths
      : splitEvenInt(Math.round(width), cols).widths;

  const cx = [];
  cw.reduce((acc, w, i) => {
    if (i === 0) cx.push(x);
    else cx.push(cx[i - 1] + cw[i - 1]);
    return 0;
  }, 0);

  const rh =
    rowHeights && rowHeights.length === rows
      ? rowHeights
      : Array.from({ length: rows }, () => rowHeight);
  const ry = [];
  ry.push(y);
  for (let i = 1; i < rows; i++) ry.push(ry[i - 1] + rh[i - 1]);

  const skip = Array.from({ length: rows }, () => Array(cols).fill(false));
  const approxTextY = (top, h, fs) => top + Math.max(0, (h - fs) / 2) - 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (skip[r][c]) continue;
      const cell = (cells[r] && cells[r][c]) || {};
      const text = typeof cell === "string" ? cell : cell.text ?? "";
      const colspan = Math.max(1, cell.colspan || 1);
      const rowspan = Math.max(1, cell.rowspan || 1);

      const w = cw.slice(c, c + colspan).reduce((a, b) => a + b, 0);
      const h = rh.slice(r, r + rowspan).reduce((a, b) => a + b, 0);
      const x0 = cx[c];
      const y0 = ry[r];

      let fillColor = null;
      if (r < headerRows) fillColor = cell.fill ?? headerFill;
      else if (bgColor) fillColor = cell.fill ?? bgColor;
      else if (cell.fill) fillColor = cell.fill;
      if (fillColor) doc.save().rect(x0, y0, w, h).fill(fillColor).restore();

      if (borderWidth > 0) {
        doc
          .save()
          .lineWidth(borderWidth)
          .strokeColor(borderColor)
          .rect(x0, y0, w, h)
          .stroke()
          .restore();
      }

      const fs =
        cell.fontSize || (r < headerRows ? TABLE_FONT.header : TABLE_FONT.body);
      const align = cell.align || "center";
      const valign = cell.valign || "middle";
      const color =
        cell.color || (r < headerRows ? headerTextColor : bodyTextColor);
      const isBold = !!cell.bold || r < headerRows;

      const tx = x0 + cellPadding;
      const tw = w - 2 * cellPadding;
      let ty = approxTextY(y0, h, fs);
      if (valign === "top") ty = y0 + cellPadding;
      if (valign === "bottom") ty = y0 + h - fs - cellPadding;

      doc
        .font(isBold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(fs)
        .fillColor(color)
        .text(text, tx, ty, { width: tw, align });

      for (let rr = r; rr < r + rowspan; rr++) {
        for (let cc = c; cc < c + colspan; cc++) {
          if (rr === r && cc === c) continue;
          if (rr < rows && cc < cols) skip[rr][cc] = true;
        }
      }
    }
  }
}

// === Semestres base para header (ajustable por ENV) ===
let SEM_LIST = ["2024-II", "2025-I", "2025-II", "2026-I"];
try {
  if (process.env.SEMESTRES_JSON) {
    const parsed = JSON.parse(process.env.SEMESTRES_JSON);
    if (Array.isArray(parsed) && parsed.length) SEM_LIST = parsed;
  }
} catch (_) {}

// === Helpers de mapeo horarios -> profesores ===
function toInt(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return val;
  const s = String(val).trim();
  if (s === "" || s === "-") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function semesterLabelFromStart(diaIni, mesIni, anoIni) {
  let y = Number(anoIni);
  if (!Number.isFinite(y)) y = 0;
  if (y < 100) y = 2000 + y; // 18 -> 2018
  const m = Number(mesIni) || 1;
  const suf = m >= 7 ? "II" : "I";
  return `${y}-${suf}`;
}

function buildNombramiento(categoria = "", tipo = "", causa = "") {
  const nivelMatch = String(categoria).match(/"([A-Z])"/);
  const nivel = nivelMatch ? nivelMatch[1] : "A";
  const inter =
    /INT|INTER/i.test(String(categoria)) ||
    /INTER|OTRO NOMB/i.test(String(causa));
  const sufijo = inter ? "INTERINO" : "";
  return `PROFESOR DE ASIGNATURA "${nivel}" ${sufijo}`.trim();
}

function formatHorariosProfesores(horarios, profesores, semestres = SEM_LIST) {
  // Helpers de indexado para búsqueda rápida por RFC / worker / nombre
  const norm = (s) =>
    s == null
      ? ""
      : String(s).trim().toUpperCase()
          .normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // quita acentos

  const byRFC = new Map();
  const byWorker = new Map();
  const byName = new Map();

  for (const p of (profesores || [])) {
    const rfcKey    = norm(p.rfc);
    const workerKey = String(p.numTrabajador ?? p.num_trabajador ?? p.trabajador ?? "").trim();
    const nameKey   = norm(p.profesor);
    const carrera   = (p.carrera ?? p.career ?? "").toString().trim() || "desconocido";

    if (rfcKey)    byRFC.set(rfcKey, carrera);
    if (workerKey) byWorker.set(workerKey, carrera);
    if (nameKey)   byName.set(nameKey, carrera);
  }

  const profMap = new Map();

  for (const h of (horarios || [])) {
    const name   = (h.profesor ?? "SIN NOMBRE").toString().trim();
    const rfc    = (h.rfc ?? "N/D").toString().trim();
    const worker = (h.numTrabajador ?? "N/D").toString().trim();

    // Buscar carrera con prioridad: RFC > worker > nombre
    let carrera = "desconocido";
    const rfcKey  = norm(rfc);
    const nameKey = norm(name);
    if (byRFC.has(rfcKey))         carrera = byRFC.get(rfcKey);
    else if (byWorker.has(worker)) carrera = byWorker.get(worker);
    else if (byName.has(nameKey))  carrera = byName.get(nameKey);

    const key = `${name}|${rfc}|${worker}`;
    if (!profMap.has(key)) {
      profMap.set(key, {
        name,
        rfc,
        worker,
        carrera,
        subjects: new Map(), // nom -> { nom, parcial: [[ht,hp] * semestres.length] }
      });
    } else {
      // Si ya estaba y no tenía carrera, actualiza si ahora sí la encontramos
      const p = profMap.get(key);
      if (p.carrera === "desconocido" && carrera !== "desconocido") {
        p.carrera = carrera;
      }
    }

    const prof = profMap.get(key);

    const nom = buildNombramiento(h.categoria, h.tipo, h.causa);
    if (!prof.subjects.has(nom)) {
      prof.subjects.set(nom, { nom, parcial: semestres.map(() => [0, 0]) });
    }
    const subj = prof.subjects.get(nom);

    const ht = toInt(h.horasTeoricas ?? h.horasTeoricasTotal ?? h.horasTotal);
    const hp = toInt(h.horasPracticas ?? h.horasPracticasTotal);

    const semLabel = semesterLabelFromStart(h.diaIni, h.mesIni, h.anoIni);
    let idx = semestres.indexOf(semLabel);
    if (idx === -1) idx = 0; // fallback a primera columna
    subj.parcial[idx][0] += ht;
    subj.parcial[idx][1] += hp;
  }

  // Convertir Maps a arreglo final
  const out = [];
  for (const [, p] of profMap) {
    const subjects = Array.from(p.subjects.values());
    out.push({ name: p.name, rfc: p.rfc, worker: p.worker, carrera: p.carrera, subjects });
  }
  return out;
}


// ==== Helpers para altura y salto de página ====
function calcRowHeight(doc, { nameInfo, nomText }) {
  const minRowH = 40;
  let hA = 0,
    hB = 0;
  if (nameInfo) {
    const { name, rfc, worker } = nameInfo;
    const nameBoxW = COL_A_W - 16;
    doc.font("Helvetica-Bold").fontSize(TABLE_FONT.nameTitle);
    const nameText = name + "\n";
    const nameH = doc.heightOfString(nameText, { width: nameBoxW });
    doc.font("Helvetica").fontSize(TABLE_FONT.nameMeta);
    const metaText = `RFC: ${rfc}
NÚMERO DE TRABAJADOR: ${worker}`;
    const metaH = doc.heightOfString(metaText, { width: nameBoxW });
    hA = 4 + nameH + 4 + metaH + 4;
  }
  if (nomText) {
    const nomW = COL_B_W - 20;
    doc.font("Helvetica").fontSize(TABLE_FONT.body);
    hB = 10 + doc.heightOfString(nomText, { width: nomW }) + 6;
  }
  return Math.max(minRowH, Math.ceil(Math.max(hA, hB, 24)));
}

function ensurePage(doc, currentY, neededH) {
  const bottom = PAGE.h - MARGIN; // pie libre
  if (currentY + neededH > bottom) {
    doc.addPage({ size: 'A4', layout: 'landscape', margin: MARGIN });
    // Reponer header de columnas en páginas siguientes
    return drawThreeRowHeader(doc, MARGIN);
  }
  return currentY;
}

async function fetchAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function header(doc, logos = {}) {
  const leftSrc = logos.left ?? null;
  const rightSrc = logos.right ?? null;

  const boxW = 80,
    boxH = 80;
  const boxY = 30; // POSICION Y DE LOS LOGOS
  const leftX = MARGIN;
  const rightX = PAGE.w - MARGIN - boxW;

  // Left logo (o placeholder)
  if (leftSrc) {
    try {
      doc.image(leftSrc, leftX, boxY, { fit: [boxW, boxH] });
    } catch (e) {
      doc
        .save()
        .rect(leftX, boxY, boxW, boxH)
        .strokeColor(C.line)
        .stroke()
        .fontSize(8)
        .fillColor(C.subtle)
        .text("LOGO", leftX, boxY + boxH / 2 - 10, {
          width: boxW,
          align: "center",
        })
        .restore();
    }
  } else {
    doc
      .save()
      .rect(leftX, boxY, boxW, boxH)
      .strokeColor(C.line)
      .stroke()
      .fontSize(8)
      .fillColor(C.subtle)
      .text("LOGO", leftX, boxY + boxH / 2 - 10, {
        width: boxW,
        align: "center",
      })
      .restore();
  }

  // Right logo (o placeholder)
  if (rightSrc) {
    try {
      doc.image(rightSrc, rightX, boxY, { fit: [boxW, boxH] });
    } catch (e) {
      doc
        .save()
        .rect(rightX, boxY, boxW, boxH)
        .strokeColor(C.line)
        .stroke()
        .fontSize(8)
        .fillColor(C.subtle)
        .text("LOGO", rightX, boxY + boxH / 2 - 10, {
          width: boxW,
          align: "center",
        })
        .restore();
    }
  } else {
    doc
      .save()
      .rect(rightX, boxY, boxW, boxH)
      .strokeColor(C.line)
      .stroke()
      .fontSize(8)
      .fillColor(C.subtle)
      .text("LOGO", rightX, boxY + boxH / 2 - 10, {
        width: boxW,
        align: "center",
      })
      .restore();
  }

  // Títulos
  let y = 40; // POSICION Y DE LOS TITULOS
  const center = (t, fs, bold = true) => {
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(fs)
      .fillColor(C.text)
      .text(t, MARGIN, y, { width: INNER_W, align: "center" });
    y += fs + 3;
  };
  center("UNIVERSIDAD NACIONAL AUTÓNOMA DE MÉXICO", TITLE_SIZES.l1);
  center("FACULTAD DE ESTUDIOS SUPERIORES ARAGÓN", TITLE_SIZES.l2);
  //center("PROFESOR DE ASIGNATURA", TITLE_SIZES.l4);
  center("BANCO DE HORAS", TITLE_SIZES.l5);
  center("SEMESTRE 2026-I", TITLE_SIZES.l6);

  return 185;
}

function drawThreeRowHeader(doc, topY) {
  const colWidths = [COL_A_W, COL_C_W, COL_B_W, RIGHT_W];
  const totalH = BAND_H * 3;

  // Fondo negro del header sin rejilla interna
  drawTable(doc, {
    x: MARGIN,
    y: topY,
    width: INNER_W,
    rows: 3,
    cols: 4,
    rowHeight: BAND_H,
    headerRows: 3,
    headerFill: C.black,
    headerTextColor: C.white,
    borderWidth: 0, // sin líneas internas
    colWidths,
    cellPadding: 8,
    cells: [
      [
        { text: "ACADÉMICO", align: "center", bold: true, valign: "top" },
        { text: "CARRERA", align: "center", bold: true, valign: "top" },
        { text: "NOMBRAMIENTO", align: "center", bold: true, valign: "top" },
        { text: "SEMESTRE", align: "center", bold: true, valign: "top" },
      ],
      [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
      [{ text: "" }, { text: "" }, { text: "" }, { text: "" }],
    ],
  });

  // Geometría
  const xAEnd = MARGIN + COL_A_W;
  const xCarrEnd = xAEnd + COL_C_W;
  const xBEnd = xCarrEnd + COL_B_W;
  const xRight = xBEnd;
  const y1 = topY + BAND_H; // fin fila 1
  const y2 = topY + BAND_H * 2; // fin fila 2
  const y3 = topY + totalH; // fin header

  const wParcial = PARCIAL_W;
  const wSem = Math.round(NUMS_W / 4);

  doc.save().lineWidth(0.8).strokeColor(C.white);

  // Borde exterior
  doc.rect(MARGIN, topY, INNER_W, totalH).stroke();

  // Separadores verticales A | CARRERA | B | Right
  doc.moveTo(xAEnd, topY).lineTo(xAEnd, y3).stroke();
  doc.moveTo(xCarrEnd, topY).lineTo(xCarrEnd, y3).stroke();
  doc.moveTo(xBEnd, topY).lineTo(xBEnd, y3).stroke();

  // Horizontal tras la 1ª fila (todo el ancho)
  doc.moveTo(MARGIN, y1).lineTo(MARGIN + INNER_W, y1).stroke();

  // Horizontal tras la 2ª fila SOLO en los semestres (omitiendo PARCIAL)
  doc.moveTo(xRight + wParcial, y2).lineTo(MARGIN + INNER_W, y2).stroke();

  // Subdivisiones verticales del bloque derecho:
  //  - Incluimos la división entre PARCIAL y el 1er semestre
  //  - y las siguientes entre semestres
  const subX = [
    xRight + wParcial,
    xRight + wParcial + wSem,
    xRight + wParcial + 2 * wSem,
    xRight + wParcial + 3 * wSem,
  ];
  subX.forEach((xx) => doc.moveTo(xx, y1).lineTo(xx, y3).stroke());

  doc.restore();

  // Etiquetas de AÑOS y HT / HP centradas en sus columnas de semestres
  const sems = SEM_LIST;
  doc.font("Helvetica-Bold").fontSize(TABLE_FONT.header).fillColor(C.white);
  sems.forEach((s, i) => {
    const x = xRight + wParcial + i * wSem;
    doc.text(s, x, y1 + (BAND_H / 2 - 6), { width: wSem, align: "center" });
  });

  doc.font("Helvetica").fontSize(TABLE_FONT.htHp).fillColor(C.white);
  sems.forEach((_, i) => {
    const x = xRight + wParcial + i * wSem;
    doc.text("HT / HP", x, y2 + (BAND_H / 2 - 5), { width: wSem, align: "center" });
  });

  return topY + totalH;
}

function drawRow(doc, topY, { nameInfo, careerText = 'desconocido', nomText, kind, values }) {
  const { widths: numCWs } = splitEvenInt(Math.round(NUMS_W), 4);

  // altura dinámica calculada previamente
  const rowH = calcRowHeight(doc, { nameInfo, nomText });

  // tabla base (A | CARRERA | B | PARCIAL | 4 SEMS)
  drawTable(doc, {
    x: MARGIN,
    y: topY,
    width: INNER_W,
    rows: 1,
    cols: 1 + 1 + 1 + 1 + 4,
    rowHeight: rowH,
    headerRows: 0,
    bgColor: kind === 'TOTAL' ? C.total : null,
    borderColor: C.line,
    borderWidth: 0.8,
    colWidths: [COL_A_W, COL_C_W, COL_B_W, PARCIAL_W, ...numCWs],
    cells: [[
      { text: '' }, // A
      { text: '' }, // CARRERA
      { text: '' }, // B
      { text: kind, fill: C.gray, bold:true, align:'center', fontSize: TABLE_FONT.parcial },
      { text: '' }, { text: '' }, { text: '' }, { text: '' }
    ]]
  });

  // valores: línea 1 => HT/HP | línea 2 => suma (HT+HP)
  const xStart = MARGIN + COL_A_W + COL_C_W + COL_B_W + PARCIAL_W;
  const xs = []; let acc = xStart;
  for (const w of numCWs) { xs.push(acc); acc += w; }

  const mid = topY + rowH / 2;
  for (let i = 0; i < 4; i++) {
    const w = numCWs[i];
    const ht = Number(values[i][0] || 0);
    const hp = Number(values[i][1] || 0);
    const sum = ht + hp;

    // Línea 1: HT/HP
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.text)
       .text(`${ht} / ${hp}`, xs[i], mid - 11, { width: w, align: 'center' });

    // Línea 2: suma
    doc.font('Helvetica').fontSize(8.5).fillColor(C.text)
       .text(String(sum), xs[i], mid + 2, { width: w, align: 'center' });
  }

  // overlays columnas A, C (carrera) y B
  if (nameInfo) {
    const { name, rfc, worker } = nameInfo;
    const nameBoxW = COL_A_W - 16;
    const nameY = topY + 8;
    const nameText = name +  "\n";

    doc.font('Helvetica-Bold').fontSize(TABLE_FONT.nameTitle).fillColor(C.text)
       .text(nameText, MARGIN + 10, nameY, { width: nameBoxW, align:'left' });

    const nameHeight = doc.heightOfString(nameText, { width: nameBoxW });
    const metaY = nameY + nameHeight - 2;

    doc.font('Helvetica').fontSize(TABLE_FONT.nameMeta)
       .text(`RFC: ${rfc}`, MARGIN + 10, metaY, { width: nameBoxW, align:'left' })
       .text(`NÚMERO DE TRABAJADOR: ${worker}`, MARGIN + 10, metaY + 10, { width: nameBoxW, align:'left' });
  }

  // Carrera (columna nueva) — no mostrar en TOTAL
if (kind !== 'TOTAL') {
  doc.font('Helvetica').fontSize(TABLE_FONT.body).fillColor(C.text)
     .text((careerText || 'desconocido'), MARGIN + COL_A_W + 10, topY + 10, { width: COL_C_W - 20, align:'left' });
}

  if (nomText) {
    doc.font('Helvetica').fontSize(TABLE_FONT.body).fillColor(C.text)
       .text(nomText, MARGIN + COL_A_W + COL_C_W + 10, topY + 10, { width: COL_B_W - 20, align:'left' });
  }

  return rowH; // para quien lo necesite
}

function drawProfessor(doc, startY, prof) {
  let y = startY;

  // filas parciales
  prof.subjects.forEach((subj, idx) => {
    const rh = calcRowHeight(doc, {
      nameInfo:
        idx === 0
          ? { name: prof.name, rfc: prof.rfc, worker: prof.worker }
          : null,
      nomText: subj.nom,
    });
    y = ensurePage(doc, y, rh);
  drawRow(doc, y, {
  nameInfo:
    idx === 0 ? { name: prof.name, rfc: prof.rfc, worker: prof.worker } : null,
  careerText: prof.carrera,   // ← agregar
  nomText: subj.nom,
  kind: "PARCIAL",
  values: subj.parcial,
});
    y += rh;
  });

  // fila total
  const total = [0, 1, 2, 3].map((i) => {
    const ht = prof.subjects.reduce((a, s) => a + (s.parcial[i][0] || 0), 0);
    const hp = prof.subjects.reduce((a, s) => a + (s.parcial[i][1] || 0), 0);
    return [ht, hp];
  });
  const totalH = calcRowHeight(doc, { nameInfo: null, nomText: "" });
  y = ensurePage(doc, y, totalH);
 drawRow(doc, y, {
  nameInfo: null,
  nomText: "",
  kind: "TOTAL",
  values: total,
});
  y += totalH;

  return y + 14; // separación entre profesores
}

// Punto de referencia anclado al borde inferior de la página
function bottomRef(doc) {
  const page = doc.page || {};
  const height = page.height || PAGE.h;
  const width = page.width || PAGE.w;
  const m = page.margins || {};
  const left = m.left ?? MARGIN;
  const right = m.right ?? MARGIN;
  const bottom = m.bottom ?? MARGIN;
  return { x: left, y: height - bottom, width: width - left - right };
}

// Agrega numeración "Página X de Y" centrada, anclada abajo
/*function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { x, y, width } = bottomRef(doc);
    const yPos = y - 10; // 10pt arriba del borde inferior
    const pageNum = i - range.start + 1;
    const total   = range.count;
    doc.font('Helvetica')
       .fontSize(8)
       .fillColor(C.subtle)
       .text(`Página ${pageNum} de ${total}`, x, yPos, {
         width,
         align: 'center',
         lineBreak: false
       });
  }
}*/

function addPageNumbers(doc, options = {}) {
  const {
    label = "Observaciones:",
    reserveRight = 70, // ancho reservado para “Página X de Y”
    offsetY = 10, // separación respecto al borde inferior
  } = options;

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const { x, y, width } = bottomRef(doc);
    const yPos = y - offsetY;
    const pageNum = i - range.start + 1;
    const total = range.count;

    const pageBoxW = reserveRight;
    const obsBoxW = Math.max(0, width - pageBoxW);

    // Estilo base
    doc.font("Helvetica").fontSize(8).fillColor(C.subtle);

    // Observaciones (izquierda)
    doc.text(label, x, yPos, {
      width: obsBoxW,
      align: "left",
      lineBreak: false,
    });

    // Línea de observaciones
    const labelW = doc.widthOfString(label);
    const lineStart = x + Math.min(labelW + 6, obsBoxW - 20);
    const lineEnd = x + obsBoxW - 8;
    if (lineEnd > lineStart) {
      doc
        .save()
        .strokeColor(C.line)
        .lineWidth(0.6)
        .moveTo(lineStart, yPos + 8)
        .lineTo(lineEnd, yPos + 8)
        .stroke()
        .restore();
    }

    // Numeración (derecha)
    doc.text(`Página ${pageNum} de ${total}`, x + obsBoxW, yPos, {
      width: pageBoxW,
      align: "right",
      lineBreak: false,
    });
  }
}

router.get("/horario-general-pdf", async (req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="horario-general.pdf"');
  //const doc = new PDFDocument({ size: "A4", margin: MARGIN });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true });

  doc.pipe(res);
  // Preparar logos: URL > PATH > placeholder
  const logos = {};
  try {
    if (LOGO_LEFT_URL) {
      logos.left = await fetchAsBuffer(LOGO_LEFT_URL);
    }
  } catch {}
  if (!logos.left && LOGO_LEFT_PATH) logos.left = LOGO_LEFT_PATH;
  try {
    if (LOGO_RIGHT_URL) {
      logos.right = await fetchAsBuffer(LOGO_RIGHT_URL);
    }
  } catch {}
  if (!logos.right && LOGO_RIGHT_PATH) logos.right = LOGO_RIGHT_PATH;

  let y = header(doc, logos);
  y = drawThreeRowHeader(doc, y - 58);

  let horariosFetched = []; let profesoresFetched = [];
try {
  const data = await fetchHorariosProfesores();
  horariosFetched = data.horarios || [];
  profesoresFetched = data.profesores || [];
} catch (_) {
  // quedarán vacíos
}

let profesoresList = formatHorariosProfesores(horariosFetched, profesoresFetched, SEM_LIST);
if (!profesoresList.length) {
  // fallback si no hay datos aún
  profesoresList = [
    {
      name: "SIN DATOS",
      rfc: "N/D",
      worker: "N/D",
      carrera: "N/D",
      subjects: [ { nom: 'SIN DATOS', parcial: SEM_LIST.map(() => [0, 0]) } ],
    },
  ];
}

profesoresList.forEach((p) => {
  y = drawProfessor(doc, y, p);
});

  addPageNumbers(doc); // Agrega numeración de páginas al final

  doc.end();
});

export default router;
