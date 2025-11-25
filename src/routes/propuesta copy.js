// src/routes/propuesta.js (ajuste HT/HP en misma línea + corrección de overlap en nombre + altura autoajustable)
import express from 'express';
import PDFDocument from 'pdfkit';

const router = express.Router();

/** ====== CONFIG ====== */
const PAGE = { w: 595.28, h: 841.89 }; // A4 pt
const MARGIN = 36;
const INNER_W = PAGE.w - 2 * MARGIN;

// Anchos principales
const COL_A_W = 180;   // Académico
const COL_B_W = 135;   // Nombramiento
const RIGHT_W  = INNER_W - COL_A_W - COL_B_W; // = PARCIAL_W + NUMS_W

// Bloque derecho
const PARCIAL_W = 60;                  // Celda gris PARCIAL/TOTAL
const NUMS_W    = RIGHT_W - PARCIAL_W; // 4 columnas (una por semestre)

// Alturas
const BAND_H = 22;  // header negro
let ROW_H  = 40;    // altura base filas (ahora autoajustable)

// Tipografías y tamaños (reducidos)
const TITLE_SIZES = {
  l1: 13, l2: 12, l3: 10, l4: 10, l5: 10, l6: 10,
};
const TABLE_FONT = {
  header: 9,
  body: 8.5,
  parcial: 9,
  nameTitle: 9.5,
  nameMeta: 8,
  htHp: 8
};

// Colores
const C = {
  black: '#000000',
  text:  '#111111',
  subtle:'#666666',
  line:  '#CFCFCF',
  gray:  '#E9E9E9',
  white: '#FFFFFF',
  total: '#F5F5F5', // fondo para fila TOTAL
};

// Rutas opcionales para logos (puedes usar variables de entorno o query params)
const LOGO_LEFT_PATH  = process.env.LOGO_LEFT_PATH  || null;
const LOGO_RIGHT_PATH = process.env.LOGO_RIGHT_PATH || null;
const LOGO_LEFT_URL  = process.env.LOGO_LEFT_URL  || 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Escudo-UNAM-escalable.svg/1066px-Escudo-UNAM-escalable.svg.png';
const LOGO_RIGHT_URL = process.env.LOGO_RIGHT_URL || 'https://lh4.googleusercontent.com/proxy/maLToT106604JBZb2spa6WgNMqlPLM_OkjVs8o_aHO2IW62WMM7RRT6qePAVUIQ35Gvgf36klFbCBUGnGOvfVF1lM6hg0Lo0dA';

/** ====== UTILS ====== */
function splitEvenInt(total, n) {
  const base = Math.floor(total / n);
  const rem  = total - base * n;
  const widths = Array.from({length:n}, (_, i) => base + (i < rem ? 1 : 0));
  return {
    widths,
    xsFrom: (x0) => widths.reduce((acc, w, i) => {
      acc.push(i === 0 ? x0 : acc[i - 1] + widths[i - 1]);
      return acc;
    }, [])
  };
}

function drawTable(doc, cfg) {
  const {
    x, y, width, rows, cols,
    colWidths, rowHeights, rowHeight = 24,
    borderColor = '#000', borderWidth = 0.5,
    bgColor = null,
    headerRows = 0, headerFill = '#000',
    headerTextColor = '#fff', bodyTextColor = '#111',
    cellPadding = 4,
    cells = []
  } = cfg;

  const cw = colWidths && colWidths.length === cols
    ? colWidths
    : splitEvenInt(Math.round(width), cols).widths;

  const cx = [];
  cw.reduce((acc, w, i) => {
    if (i === 0) cx.push(x); else cx.push(cx[i - 1] + cw[i - 1]);
    return 0;
  }, 0);

  const rh = rowHeights && rowHeights.length === rows
    ? rowHeights
    : Array.from({length: rows}, () => rowHeight);
  const ry = [];
  ry.push(y);
  for (let i = 1; i < rows; i++) ry.push(ry[i - 1] + rh[i - 1]);

  const skip = Array.from({length: rows}, () => Array(cols).fill(false));
  const approxTextY = (top, h, fs) => top + Math.max(0, (h - fs) / 2) - 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (skip[r][c]) continue;
      const cell = (cells[r] && cells[r][c]) || {};
      const text = typeof cell === 'string' ? cell : (cell.text ?? '');
      const colspan = Math.max(1, cell.colspan || 1);
      const rowspan = Math.max(1, cell.rowspan || 1);

      const w = cw.slice(c, c + colspan).reduce((a,b)=>a+b, 0);
      const h = rh.slice(r, r + rowspan).reduce((a,b)=>a+b, 0);
      const x0 = cx[c];
      const y0 = ry[r];

      let fillColor = null;
      if (r < headerRows) fillColor = cell.fill ?? headerFill;
      else if (bgColor)   fillColor = cell.fill ?? bgColor;
      else if (cell.fill) fillColor = cell.fill;
      if (fillColor) doc.save().rect(x0, y0, w, h).fill(fillColor).restore();

      if (borderWidth > 0) {
        doc.save().lineWidth(borderWidth).strokeColor(borderColor)
           .rect(x0, y0, w, h).stroke().restore();
      }

      const fs     = cell.fontSize || (r < headerRows ? TABLE_FONT.header : TABLE_FONT.body);
      const align  = cell.align || 'center';
      const valign = cell.valign || 'middle';
      const color  = cell.color || (r < headerRows ? headerTextColor : bodyTextColor);
      const isBold = !!cell.bold || r < headerRows;

      const tx = x0 + cellPadding;
      const tw = w - 2 * cellPadding;
      let ty = approxTextY(y0, h, fs);
      if (valign === 'top') ty = y0 + cellPadding;
      if (valign === 'bottom') ty = y0 + h - fs - cellPadding;

      doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica')
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

// ==== Helpers para altura y salto de página ====
function calcRowHeight(doc, { nameInfo, nomText }) {
  const minRowH = 40;
  let hA = 0, hB = 0;
  if (nameInfo) {
    const { name, rfc, worker } = nameInfo;
    const nameBoxW = COL_A_W - 16;
    doc.font('Helvetica-Bold').fontSize(TABLE_FONT.nameTitle);
    const nameText = name + '\n';
    const nameH = doc.heightOfString(nameText, { width: nameBoxW });
    doc.font('Helvetica').fontSize(TABLE_FONT.nameMeta);
    const metaText = `RFC: ${rfc}
NÚMERO DE TRABAJADOR: ${worker}`;
    const metaH = doc.heightOfString(metaText, { width: nameBoxW });
    hA = 4 + nameH + 4 + metaH + 4;
  }
  if (nomText) {
    const nomW = COL_B_W - 20;
    doc.font('Helvetica').fontSize(TABLE_FONT.body);
    hB = 10 + doc.heightOfString(nomText, { width: nomW }) + 6;
  }
  return Math.max(minRowH, Math.ceil(Math.max(hA, hB, 24)));
}

function ensurePage(doc, currentY, neededH) {
  const bottom = PAGE.h - MARGIN; // pie libre
  if (currentY + neededH > bottom) {
    doc.addPage({ size: 'A4', margin: MARGIN });
    // Reponer header de columnas en páginas siguientes
    return drawThreeRowHeader(doc, MARGIN + 8);
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
  const leftSrc  = logos.left ?? null;
  const rightSrc = logos.right ?? null;

  const boxW = 90, boxH = 90;
  const boxY = 58;
  const leftX = MARGIN;
  const rightX = PAGE.w - MARGIN - boxW;

  // Left logo (o placeholder)
  if (leftSrc) {
    try {
      doc.image(leftSrc, leftX, boxY, { fit: [boxW, boxH] });
    } catch (e) {
      doc.save().rect(leftX, boxY, boxW, boxH).strokeColor(C.line).stroke()
        .fontSize(8).fillColor(C.subtle).text('LOGO', leftX, boxY + boxH/2 - 10, { width: boxW, align: 'center' }).restore();
    }
  } else {
    doc.save().rect(leftX, boxY, boxW, boxH).strokeColor(C.line).stroke()
      .fontSize(8).fillColor(C.subtle).text('LOGO', leftX, boxY + boxH/2 - 10, { width: boxW, align: 'center' }).restore();
  }

  // Right logo (o placeholder)
  if (rightSrc) {
    try {
      doc.image(rightSrc, rightX, boxY, { fit: [boxW, boxH] });
    } catch (e) {
      doc.save().rect(rightX, boxY, boxW, boxH).strokeColor(C.line).stroke()
        .fontSize(8).fillColor(C.subtle).text('LOGO', rightX, boxY + boxH/2 - 10, { width: boxW, align: 'center' }).restore();
    }
  } else {
    doc.save().rect(rightX, boxY, boxW, boxH).strokeColor(C.line).stroke()
      .fontSize(8).fillColor(C.subtle).text('LOGO', rightX, boxY + boxH/2 - 10, { width: boxW, align: 'center' }).restore();
  }

  // Títulos
  let y = 80;
  const center = (t, fs, bold=true) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(C.text)
       .text(t, MARGIN, y, { width: INNER_W, align: 'center' });
    y += fs + 3;
  };
  center('UNIVERSIDAD NACIONAL AUTÓNOMA DE MÉXICO', TITLE_SIZES.l1);
  center('FACULTAD DE ESTUDIOS SUPERIORES ARAGÓN', TITLE_SIZES.l2);
  center('INGENIERÍA EN COMPUTACIÓN', TITLE_SIZES.l3);
  center('PROFESOR DE ASIGNATURA', TITLE_SIZES.l4);
  center('BANCO DE HORAS', TITLE_SIZES.l5);
  center('SEMESTRE 2026-I', TITLE_SIZES.l6);

  return 185;
}

function drawThreeRowHeader(doc, topY) {
  const colWidths = [COL_A_W, COL_B_W, RIGHT_W];

  drawTable(doc, {
    x: MARGIN,
    y: topY,
    width: INNER_W,
    rows: 3,
    cols: 3,
    rowHeight: BAND_H,
    headerRows: 3,
    headerFill: C.black,
    headerTextColor: C.white,
    borderColor: C.white,
    borderWidth: 0.8,
    colWidths,
    cells: [
      [
        { text:'ACADÉMICO',    align:'left',  bold:true },
        { text:'NOMBRAMIENTO', align:'left',  bold:true },
        { text:'SEMESTRE',     align:'center', bold:true }
      ],
      [{ text:'' }, { text:'' }, { text:'' }],
      [{ text:'' }, { text:'' }, { text:'' }]
    ]
  });

  const xRight = MARGIN + COL_A_W + COL_B_W;
  const wParcial = PARCIAL_W;
  const wSem = Math.round(NUMS_W / 4);

  const subXs = [xRight, xRight + wParcial, xRight + wParcial + wSem, xRight + wParcial + 2*wSem, xRight + wParcial + 3*wSem];
  const subWs = [wParcial, wSem, wSem, wSem, wSem];

  doc.save().lineWidth(0.8).strokeColor(C.white);
  for (let i = 1; i < 5; i++) {
    const x = subXs[i];
    doc.moveTo(x, topY + BAND_H).lineTo(x, topY + BAND_H * 3).stroke();
  }
  doc.restore();

  const sems = ['2024-II', '2025-I', '2025-II', '2026-I'];
  doc.font('Helvetica-Bold').fontSize(TABLE_FONT.header).fillColor(C.white);
  sems.forEach((s, i) => {
    const x = subXs[i + 1];
    const w = subWs[i + 1];
    doc.text(s, x, topY + BAND_H + (BAND_H/2 - 6), { width: w, align: 'center' });
  });

  doc.font('Helvetica').fontSize(TABLE_FONT.htHp).fillColor(C.white);
  sems.forEach((_, i) => {
    const x = subXs[i + 1];
    const w = subWs[i + 1];
    doc.text('HT / HP', x, topY + 2 * BAND_H + (BAND_H/2 - 5), { width: w, align: 'center' });
  });

  return topY + BAND_H * 3;
}

function drawRow(doc, topY, { nameInfo, nomText, kind, values }) {
  const { widths: numCWs } = splitEvenInt(Math.round(NUMS_W), 4);

  // altura dinámica calculada previamente
  const rowH = calcRowHeight(doc, { nameInfo, nomText });

  // tabla base
  drawTable(doc, {
    x: MARGIN,
    y: topY,
    width: INNER_W,
    rows: 1,
    cols: 1 + 1 + 1 + 4,
    rowHeight: rowH,
    headerRows: 0,
    bgColor: kind === 'TOTAL' ? C.total : null,
    borderColor: C.line,
    borderWidth: 0.8,
    colWidths: [COL_A_W, COL_B_W, PARCIAL_W, ...numCWs],
    cells: [[
      { text: '' }, { text: '' },
      { text: kind, fill: C.gray, bold:true, align:'center', fontSize: TABLE_FONT.parcial },
      { text: '' }, { text: '' }, { text: '' }, { text: '' }
    ]]
  });

  // valores: línea 1 => HT/HP | línea 2 => suma (HT+HP)
  const xStart = MARGIN + COL_A_W + COL_B_W + PARCIAL_W;
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

  // overlays columnas A y B
  if (nameInfo) {
    const { name, rfc, worker } = nameInfo;
    const nameBoxW = COL_A_W - 16;
    const nameY = topY + 8;
    const nameText = name + '\n';

    doc.font('Helvetica-Bold').fontSize(TABLE_FONT.nameTitle).fillColor(C.text)
       .text(nameText, MARGIN + 10, nameY, { width: nameBoxW, align:'left' });

    const nameHeight = doc.heightOfString(nameText, { width: nameBoxW });
    const metaY = nameY + nameHeight - 2;

    doc.font('Helvetica').fontSize(TABLE_FONT.nameMeta)
       .text(`RFC: ${rfc}`, MARGIN + 10, metaY, { width: nameBoxW, align:'left' })
       .text(`NÚMERO DE TRABAJADOR: ${worker}`, MARGIN + 10, metaY + 10, { width: nameBoxW, align:'left' });
  }

  if (nomText) {
    doc.font('Helvetica').fontSize(TABLE_FONT.body).fillColor(C.text)
       .text(nomText, MARGIN + COL_A_W + 10, topY + 10, { width: COL_B_W - 20, align:'left' });
  }

  return rowH; // para quien lo necesite
}

function drawProfessor(doc, startY, prof) {
  let y = startY;

  // filas parciales
  prof.subjects.forEach((subj, idx) => {
    const rh = calcRowHeight(doc, { nameInfo: idx === 0 ? { name: prof.name, rfc: prof.rfc, worker: prof.worker } : null, nomText: subj.nom });
    y = ensurePage(doc, y, rh);
    drawRow(doc, y, {
      nameInfo: idx === 0 ? { name: prof.name, rfc: prof.rfc, worker: prof.worker } : null,
      nomText: subj.nom,
      kind: 'PARCIAL',
      values: subj.parcial
    });
    y += rh;
  });

  // fila total
  const total = [0,1,2,3].map(i => {
    const ht = prof.subjects.reduce((a, s) => a + (s.parcial[i][0] || 0), 0);
    const hp = prof.subjects.reduce((a, s) => a + (s.parcial[i][1] || 0), 0);
    return [ht, hp];
  });
  const totalH = calcRowHeight(doc, { nameInfo: null, nomText: '' });
  y = ensurePage(doc, y, totalH);
  drawRow(doc, y, { nameInfo: null, nomText: '', kind: 'TOTAL', values: total });
  y += totalH;

  return y + 14; // separación entre profesores
}

router.get('/propuesta-pdf', async (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="propuesta.pdf"');
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
  doc.pipe(res);
  // Preparar logos: URL > PATH > placeholder
  const logos = {};
  try { if (LOGO_LEFT_URL)  { logos.left  = await fetchAsBuffer(LOGO_LEFT_URL); } } catch {}
  if (!logos.left && LOGO_LEFT_PATH)  logos.left  = LOGO_LEFT_PATH;
  try { if (LOGO_RIGHT_URL) { logos.right = await fetchAsBuffer(LOGO_RIGHT_URL); } } catch {}
  if (!logos.right && LOGO_RIGHT_PATH) logos.right = LOGO_RIGHT_PATH;

  let y = header(doc, logos);
  y = drawThreeRowHeader(doc, y + 8);

  const profesores = [
    { name: 'LOPEZ HERNANDEZ JORGE ARTURO', rfc: 'LOHJ880308M91', worker: '861979',
      subjects: [
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[8,0],[8,0],[8,0],[8,0]] },
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[2,0],[2,0],[2,0],[2,0]] },
      ]
    },
    { name: 'RAMIREZ LAZOS ESTEBAN', rfc: 'LOSE090809F00', worker: '999999',
      subjects: [
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[4,0],[4,0],[4,0],[4,0]] },
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[2,0],[2,0],[2,0],[2,0]] },
      ]
    },
    { name: 'HERNANDEZ CABRERA JESUS', rfc: 'NOME090909L03', worker: '89999',
      subjects: [
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[0,4],[0,2],[0,4],[0,2]] },
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[4,0],[4,0],[0,0],[0,0]] },
      ]
    },
    { name: 'GOMEZ RUIZ ANA SOFIA', rfc: 'GORS920101H12', worker: '882341',
      subjects: [
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[3,1],[3,1],[3,1],[3,1]] },
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[2,0],[2,0],[2,0],[2,0]] },
      ]
    },
    { name: 'PEREZ MENDOZA LUIS ALBERTO', rfc: 'PEML850715K89', worker: '771234',
      subjects: [
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[6,0],[0,2],[6,0],[0,2]] },
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[2,0],[2,0],[2,0],[2,0]] },
      ]
    },
    { name: 'SANTOS VARGAS DIANA LAURA', rfc: 'SVDL930412M21', worker: '660987',
      subjects: [
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[0,4],[0,4],[0,4],[0,4]] },
        { nom: 'PROFESOR DE ASIGNATURA "A" INTERINO', parcial: [[1,1],[1,1],[1,1],[1,1]] },
      ]
    }
  ];
  profesores.forEach(p => { y = drawProfessor(doc, y, p); });
  doc.end();
});

export default router;
