// Minimal PDF report builder on top of pdfkit: title block, KPI strip, section
// headings, and paginated tables with repeating headers.
//
// Fonts are the bundled Noto family (assets/fonts) rather than pdfkit's built-in
// Helvetica, because the built-ins are Latin-1 only: the rupee sign and Tamil
// customer names would come out as garbage. Tamil is a separate face, picked
// per string, since pdfkit has no per-glyph font fallback.

import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FONT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "fonts"
);
const FONTS = {
  body: path.join(FONT_DIR, "NotoSans-Regular.ttf"),
  bold: path.join(FONT_DIR, "NotoSans-Bold.ttf"),
  tamil: path.join(FONT_DIR, "NotoSansTamil-Regular.ttf"),
};

const TAMIL_RE = /[஀-௿]/;

const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";
const HEAD_BG = "#1f2937";
const ZEBRA = "#f6f7f9";
const ACCENT = "#0f766e";

export interface Column {
  header: string;
  /** Relative weight; widths are shared out across the content area. */
  width: number;
  align?: "left" | "right";
}

export type Cell = string | number | null | undefined;

/** Builds one report PDF. Call the section helpers in order, then `finish()`. */
export class PdfReport {
  private doc: PDFKit.PDFDocument;
  private chunks: Buffer[] = [];
  private done: Promise<Buffer>;

  constructor() {
    this.doc = new PDFDocument({
      size: "A4",
      margins: { top: 44, bottom: 52, left: 40, right: 40 },
      bufferPages: true,
      autoFirstPage: true,
    });
    this.doc.registerFont("body", FONTS.body);
    this.doc.registerFont("bold", FONTS.bold);
    this.doc.registerFont("tamil", FONTS.tamil);
    this.doc.font("body").fillColor(INK);

    this.done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on("data", (c: Buffer) => this.chunks.push(c));
      this.doc.on("end", () => resolve(Buffer.concat(this.chunks)));
      this.doc.on("error", reject);
    });
  }

  private get left(): number {
    return this.doc.page.margins.left;
  }
  private get contentWidth(): number {
    return this.doc.page.width - this.left - this.doc.page.margins.right;
  }
  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  /** Tamil text needs the Tamil face; everything else uses Noto Sans. */
  private use(text: string, bold = false): PDFKit.PDFDocument {
    return this.doc.font(TAMIL_RE.test(text) ? "tamil" : bold ? "bold" : "body");
  }

  /** Start a new page when `needed` points would not fit on the current one. */
  private ensure(needed: number): void {
    if (this.doc.y + needed > this.bottom) this.doc.addPage();
  }

  title(main: string, subtitle?: string, meta?: string): this {
    this.use(main, true).fontSize(20).fillColor(INK).text(main, this.left, this.doc.y);
    if (subtitle) {
      this.doc.moveDown(0.25);
      this.use(subtitle).fontSize(11).fillColor(ACCENT).text(subtitle);
    }
    if (meta) {
      this.doc.moveDown(0.15);
      this.use(meta).fontSize(9).fillColor(MUTED).text(meta);
    }
    this.doc.moveDown(0.6);
    const y = this.doc.y;
    this.doc
      .moveTo(this.left, y)
      .lineTo(this.left + this.contentWidth, y)
      .lineWidth(1)
      .strokeColor(RULE)
      .stroke();
    this.doc.y = y + 14;
    this.doc.fillColor(INK);
    return this;
  }

  /** A row of headline figures (total orders, total value, ...). */
  kpis(items: { label: string; value: string }[]): this {
    if (items.length === 0) return this;
    const gap = 10;
    const boxW = (this.contentWidth - gap * (items.length - 1)) / items.length;
    const boxH = 52;
    this.ensure(boxH + 12);
    const top = this.doc.y;

    items.forEach((it, i) => {
      const x = this.left + i * (boxW + gap);
      this.doc.roundedRect(x, top, boxW, boxH, 5).fillColor("#f3f4f6").fill();
      this.use(it.label)
        .fontSize(8)
        .fillColor(MUTED)
        .text(it.label.toUpperCase(), x + 10, top + 9, {
          width: boxW - 20,
          lineBreak: false,
        });
      this.use(it.value, true)
        .fontSize(14)
        .fillColor(INK)
        .text(it.value, x + 10, top + 24, { width: boxW - 20, lineBreak: false });
    });

    this.doc.y = top + boxH + 16;
    this.doc.x = this.left;
    this.doc.fillColor(INK);
    return this;
  }

  section(heading: string): this {
    this.ensure(46);
    this.doc.moveDown(0.2);
    this.use(heading, true)
      .fontSize(12)
      .fillColor(INK)
      .text(heading, this.left, this.doc.y);
    this.doc.moveDown(0.4);
    return this;
  }

  /** Small caption / note line in muted type. */
  note(text: string): this {
    this.ensure(20);
    this.use(text).fontSize(8.5).fillColor(MUTED).text(text, this.left, this.doc.y, {
      width: this.contentWidth,
    });
    this.doc.moveDown(0.4);
    this.doc.fillColor(INK);
    return this;
  }

  /** A label/value list, used for the summary block. */
  keyValues(rows: [string, string][]): this {
    const labelW = Math.min(190, this.contentWidth * 0.45);
    for (const [k, v] of rows) {
      this.ensure(18);
      const y = this.doc.y;
      this.use(k)
        .fontSize(9.5)
        .fillColor(MUTED)
        .text(k, this.left, y, { width: labelW, lineBreak: false });
      this.use(v, true)
        .fontSize(9.5)
        .fillColor(INK)
        .text(v, this.left + labelW, y, {
          width: this.contentWidth - labelW,
          lineBreak: false,
        });
      this.doc.y = y + 15;
    }
    this.doc.moveDown(0.3);
    this.doc.x = this.left;
    return this;
  }

  /**
   * A table with a repeating header row. Cells are rendered as text; numbers are
   * stringified by the caller so formatting stays in one place.
   */
  table(columns: Column[], rows: Cell[][], opts: { zebra?: boolean } = {}): this {
    const zebra = opts.zebra ?? true;
    const totalWeight = columns.reduce((a, c) => a + c.width, 0);
    const widths = columns.map((c) => (c.width / totalWeight) * this.contentWidth);
    const padX = 6;
    const fontSize = 8.5;

    const drawHeader = () => {
      const h = 20;
      this.ensure(h + 18);
      const y = this.doc.y;
      this.doc.rect(this.left, y, this.contentWidth, h).fillColor(HEAD_BG).fill();
      let x = this.left;
      columns.forEach((c, i) => {
        this.doc
          .font("bold")
          .fontSize(fontSize)
          .fillColor("#ffffff")
          .text(c.header, x + padX, y + 6, {
            width: widths[i] - padX * 2,
            align: c.align ?? "left",
            lineBreak: false,
          });
        x += widths[i];
      });
      this.doc.y = y + h;
      this.doc.fillColor(INK);
    };

    drawHeader();

    rows.forEach((row, r) => {
      const texts = row.map((v) => (v === null || v === undefined ? "" : String(v)));
      // Row height is driven by the tallest wrapped cell.
      const heights = texts.map((t, i) => {
        this.use(t).fontSize(fontSize);
        return this.doc.heightOfString(t, { width: widths[i] - padX * 2 });
      });
      const rowH = Math.max(16, Math.max(...heights, 0) + 7);

      if (this.doc.y + rowH > this.bottom) {
        this.doc.addPage();
        drawHeader();
      }

      const y = this.doc.y;
      if (zebra && r % 2 === 1) {
        this.doc.rect(this.left, y, this.contentWidth, rowH).fillColor(ZEBRA).fill();
      }
      let x = this.left;
      texts.forEach((t, i) => {
        this.use(t).fontSize(fontSize).fillColor(INK).text(t, x + padX, y + 4, {
          width: widths[i] - padX * 2,
          align: columns[i].align ?? "left",
        });
        x += widths[i];
      });
      this.doc.y = y + rowH;
      this.doc
        .moveTo(this.left, this.doc.y)
        .lineTo(this.left + this.contentWidth, this.doc.y)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
    });

    this.doc.x = this.left;
    this.doc.moveDown(0.8);
    return this;
  }

  /** A highlighted single figure, used for the grand total. */
  totalBar(label: string, value: string): this {
    const h = 30;
    this.ensure(h + 10);
    const y = this.doc.y;
    this.doc.rect(this.left, y, this.contentWidth, h).fillColor(ACCENT).fill();
    this.use(label, true)
      .fontSize(10)
      .fillColor("#ffffff")
      .text(label.toUpperCase(), this.left + 10, y + 10, {
        width: this.contentWidth / 2,
        lineBreak: false,
      });
    this.use(value, true)
      .fontSize(13)
      .fillColor("#ffffff")
      .text(value, this.left + this.contentWidth / 2, y + 8, {
        width: this.contentWidth / 2 - 10,
        align: "right",
        lineBreak: false,
      });
    this.doc.y = y + h + 12;
    this.doc.x = this.left;
    this.doc.fillColor(INK);
    return this;
  }

  /** Stamp "Page n of m" on every page and return the finished bytes. */
  async finish(footerNote: string): Promise<Buffer> {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      // The footer sits below the bottom margin; drop the margin while writing
      // it, otherwise pdfkit treats it as overflow and appends a fresh page.
      const bottomMargin = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      const y = this.doc.page.height - bottomMargin + 16;
      const w = this.doc.page.width - this.left - this.doc.page.margins.right;
      this.doc.font("body").fontSize(8).fillColor(MUTED);
      this.doc.text(footerNote, this.left, y, { width: w / 2, lineBreak: false });
      this.doc.text(`Page ${i - range.start + 1} of ${range.count}`, this.left + w / 2, y, {
        width: w / 2,
        align: "right",
        lineBreak: false,
      });
      this.doc.page.margins.bottom = bottomMargin;
    }
    this.doc.end();
    return this.done;
  }
}
