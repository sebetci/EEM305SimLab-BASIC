/**
 * @file        core/js/assembler.js
 * @summary     Assembler (derleyici): 8051 assembly kaynak kodunu makine koduna (byte'lara) çevirir.
 * @description "Derle" düğmesi bu dosyadaki {@link assemble} fonksiyonunu çağırır. Assembler İKİ GEÇİŞ yapar:
 *
 *                1. geçiş — Her satırın komut biçimi bulunur ve uzunluğu hesaplanır; böylece her satırın
 *                   flash adresi ve her etiketin (ör. `Loop:`) adresi bilinir → sembol tablosu.
 *                2. geçiş — Her satır için opcode, opcode tablosundan (opcodes.js) alınır; operandlar
 *                   hesaplanıp byte'lara çevrilir. Etiketlerin adresleri artık bilindiği için kodun
 *                   ilerisindeki bir etikete yapılan atlamalar da hesaplanabilir.
 *
 *              Assembler'ın çıktısı bir LİSTE'dir: her satır için adres, makine kodu ve kaynak metin.
 *              Byte'ları flash'a yazmak assembler'ın değil, emulator.js → loadProgram() fonksiyonunun işidir.
 *
 *              Desteklenenler: etiket (`Ad:`), yorum (`;`), direktifler `ORG` ve `END`,
 *              sayılar `05h`, `0x1F`, `1010b`, `25`, `'A'`, bulunulan adres `$`, toplama/çıkarma (`Tablo+1`),
 *              SFR adları (`P1`, `ACC`, `B`, `SP`, `PSW`, `DPL`, `DPH` …). `CALL` → `LCALL`, `JMP` → `LJMP`.
 *
 * @author      Sercan Sebetçi <sercan.sebetci@ogr.sakarya.edu.tr>
 * @copyright   2026 Sercan Sebetçi
 * @license     MIT
 * @version     1.0.0 (2026-11-15)
 */

/**
 * Derleme listesinin bir satırı.
 * @typedef  {Object} ListingLine
 * @property {number} line        Kaynak koddaki satır numarası (1'den başlar).
 * @property {string} src         Kaynak satır (yorumsuz).
 * @property {string} label       Satırdaki etiket (yoksa boş).
 * @property {?number} addr       Komutun flash adresi (komut olmayan satırlarda `null`).
 * @property {number[]} bytes     Makine kodu.
 * @property {?OpcodeEntry} entry Opcode tablosundaki satır.
 * @property {string[]} notes     Kodlamanın açıklaması (ör. "MOV A,Rn → E8h + 3 = EBh").
 */

/**
 * Derleme sonucu.
 * @typedef  {Object} AsmResult
 * @property {boolean} ok                         Hata yoksa `true`.
 * @property {Array<{line: number, msg: string}>} errors  Hatalar.
 * @property {ListingLine[]} listing              Derleme listesi.
 * @property {Object<string, number>} symbols     Etiket → adres.
 */

// === 1. Satırı parçalarına ayırma ===

/**
 * Bir kaynak satırını etiket, komut adı ve operandlara ayırır.
 * @param {string} raw - Kaynak satır.
 * @returns {{label: string, mn: string, ops: string[], text: string}}
 * @example parseLine("Loop: DJNZ R7,Loop ; sayaç")  // { label: "Loop", mn: "DJNZ", ops: ["R7", "Loop"], … }
 */
function parseLine(raw) {
  let s = raw.replace(/;.*$/, "").trim();          // ; ile başlayan yorum atılır
  let label = "";
  const m = s.match(/^([A-Za-z_]\w*)\s*:\s*(.*)$/); // "Etiket:" varsa ayrılır
  if (m) { label = m[1]; s = m[2].trim(); }
  if (!s) return { label, mn: "", ops: [], text: "" };
  const sp = s.search(/\s/);
  let mn = (sp < 0 ? s : s.slice(0, sp)).toUpperCase();
  const ops = sp < 0 ? [] : s.slice(sp + 1).split(",").map(x => x.trim()).filter(x => x);
  if (mn === "CALL") mn = "LCALL";
  if (mn === "JMP") mn = "LJMP";
  return { label, mn, ops, text: s };
}

/**
 * Bir operandın türünü belirler. Sayı ya da etiket olan operandlar `"expr"` türündedir; bunların
 * `dir`, `rel` ya da `addr16` olduğuna komut biçimi karar verir.
 * @param {string} tok - Operand metni.
 * @returns {{kind: string, n?: number, i?: number, expr?: string}}
 */
function classifyOperand(tok) {
  const u = tok.toUpperCase().replace(/\s+/g, "");
  if (u === "A" || u === "C" || u === "DPTR") return { kind: u };
  let m = u.match(/^R([0-7])$/);
  if (m) return { kind: "Rn", n: +m[1] };
  m = u.match(/^@R([01])$/);
  if (m) return { kind: "@Ri", i: +m[1] };
  if (u[0] === "#") return { kind: "#", expr: tok.trim().slice(1) };
  return { kind: "expr", expr: tok.trim() };
}

/**
 * Bir operand, komut biçimindeki bir türe uyuyor mu?
 * @param {string} kind - Biçimdeki tür (ör. `"Rn"`, `"#data"`, `"dir"`).
 * @param {{kind: string}} op - {@link classifyOperand} sonucu.
 * @returns {boolean}
 */
function operandFits(kind, op) {
  if (kind === "#data" || kind === "#data16") return op.kind === "#";
  if (kind === "dir" || kind === "rel" || kind === "addr16") return op.kind === "expr";
  return kind === op.kind;
}

/**
 * Komut adı ve operandlara uyan biçimi opcode tablosunda arar.
 * @param {string} mn - Komut adı.
 * @param {Array} ops - Sınıflandırılmış operandlar.
 * @returns {?OpcodeEntry} Biçimin İLK opcode'u (Rn/@Ri biçimlerinde register 0'ınki); yoksa `null`.
 */
function findFormat(mn, ops) {
  return OPCODE_TABLE.find(e => e && e.mn === mn && (e.reg === undefined || e.reg === 0) &&
    e.kinds.length === ops.length && e.kinds.every((k, i) => operandFits(k, ops[i]))) || null;
}

// === 2. Sayı ve ifade hesaplama ===

/**
 * Bir ifadeyi hesaplar: sayı, `$`, etiket ya da SFR adı; `+` ve `-` ile birleştirilebilir.
 * @param {string} e - İfade (ör. `"30h"`, `"Loop"`, `"Tablo+2"`, `"P1"`).
 * @param {Object<string, number>} sym - Sembol tablosu.
 * @param {number} pc - Satırın adresi (`$` için).
 * @param {boolean} strict - `true` ise tanımsız sembol hata verir (2. geçiş).
 * @returns {number}
 * @throws {string} Tanımsız sembol ya da geçersiz sayı.
 */
function evaluate(e, sym, pc, strict) {
  const parts = e.replace(/\s+/g, "").match(/[+-]?[^+-]+/g) || [];
  if (!parts.length) throw "Değer eksik";
  let total = 0;
  for (let p of parts) {
    let sign = 1;
    if (p[0] === "+" || p[0] === "-") { if (p[0] === "-") sign = -1; p = p.slice(1); }
    const U = p.toUpperCase();
    let v, m;
    if (p === "$") v = pc;
    else if ((m = p.match(/^0x([0-9a-f]+)$/i))) v = parseInt(m[1], 16);
    else if ((m = p.match(/^([0-9][0-9a-f]*)h$/i))) v = parseInt(m[1], 16);
    else if ((m = p.match(/^([01]+)b$/i))) v = parseInt(m[1], 2);
    else if ((m = p.match(/^\d+$/))) v = parseInt(p, 10);
    else if ((m = p.match(/^'(.)'$/))) v = m[1].charCodeAt(0);
    else if (U in sym) v = sym[U];
    else if (U in SFR_ADDR) v = SFR_ADDR[U];
    else if (!strict && /^[A-Z_]\w*$/.test(U)) v = 0;  // 1. geçişte henüz bilinmeyen etiket
    else throw "Tanımsız sembol ya da geçersiz sayı: " + p;
    total += sign * v;
  }
  return total;
}

// === 3. Assembler ===

/**
 * Kaynak kodu derler.
 * @param {string} src - 8051 assembly kaynak kodu.
 * @returns {AsmResult}
 */
function assemble(src) {
  const lines = src.replace(/\r/g, "").split("\n").map(parseLine);
  const errors = [], symbols = {};
  let listing = [];

  for (let pass = 1; pass <= 2; pass++) {
    let pc = 0;
    listing = [];
    for (let k = 0; k < lines.length; k++) {
      const L = lines[k], row = { line: k + 1, src: L.text, label: L.label, addr: null, bytes: [], entry: null, notes: [] };
      try {
        // Etiket: o anki adres sembol tablosuna yazılır
        if (L.label) {
          const key = L.label.toUpperCase();
          if (pass === 1 && key in symbols) throw "Aynı etiket iki kez tanımlanmış: " + L.label;
          symbols[key] = pc;
          row.addr = pc;
        }
        if (!L.mn) { if (L.label) listing.push(row); continue; }
        if (L.mn === "END") break;
        if (L.mn === "ORG") {   // ORG: sonraki komutların yerleşeceği adresi değiştirir
          pc = evaluate(L.ops.join(","), symbols, pc, true) & 0xFFFF;
          row.notes.push("Adres sayacı ← " + hex4(pc) + "h");
          listing.push(row); continue;
        }

        // Biçimi bul: komut adı + operand türleri → opcode tablosundaki satır
        const ops = L.ops.map(classifyOperand);
        const fmt = findFormat(L.mn, ops);
        if (!fmt) {
          if (!OPCODE_TABLE.some(e => e && e.mn === L.mn)) throw "Bu uygulamada desteklenmeyen komut: " + L.mn;
          throw L.mn + " için bu operandlar desteklenmiyor";
        }
        row.addr = pc;

        // Opcode: tablodaki temel opcode; Rn / @Ri biçimlerinde register numarası eklenir
        const regOp = ops.find(o => o.kind === "Rn" || o.kind === "@Ri");
        const reg = regOp ? (regOp.kind === "Rn" ? regOp.n : regOp.i) : undefined;
        const entry = OPCODE_TABLE[fmt.opcode + (reg || 0)];
        row.entry = entry;
        row.bytes = [entry.opcode];
        row.notes.push("Biçim " + entry.fmt + " → opcode " + (reg !== undefined ? hex2(fmt.opcode) + "h + " + reg + " = " : "") + hex2(entry.opcode) + "h");

        // Operand byte'ları, biçimdeki sırayla eklenir
        const next = pc + entry.len;   // sıradaki komutun adresi (bağıl atlamalar buna göre hesaplanır)
        entry.kinds.forEach((kind, i) => {
          const op = ops[i];
          if (kind === "#data") {
            const v = evaluate(op.expr, symbols, pc, pass === 2);
            if (pass === 2 && (v < -128 || v > 255)) throw "8 bit sabit aralık dışında: " + op.expr;
            row.bytes.push(v & 0xFF); row.notes.push("#data = " + hex2(v) + "h");
          } else if (kind === "#data16") {
            const v = evaluate(op.expr, symbols, pc, pass === 2) & 0xFFFF;
            row.bytes.push(v >> 8, v & 0xFF); row.notes.push("#data16 = " + hex4(v) + "h → önce yüksek byte " + hex2(v >> 8) + "h, sonra düşük byte " + hex2(v) + "h");
          } else if (kind === "dir") {
            const v = evaluate(op.expr, symbols, pc, pass === 2);
            if (pass === 2 && (v < 0 || v > 255)) throw "Doğrudan adres 00h–FFh aralığında olmalı: " + op.expr;
            row.bytes.push(v & 0xFF); row.notes.push("dir = " + hex2(v) + "h" + (v >= 0x80 ? " (" + sfrName(v) + ")" : " (RAM)"));
          } else if (kind === "rel") {
            const target = evaluate(op.expr, symbols, pc, pass === 2), off = target - next;
            if (pass === 2 && (off < -128 || off > 127)) throw "Atlama hedefi çok uzak (−128…+127 byte): " + op.expr;
            row.bytes.push(off & 0xFF);
            row.notes.push("rel = hedef − sıradaki adres = " + hex4(target) + "h − " + hex4(next) + "h = " + off + " → " + hex2(off) + "h");
          } else if (kind === "addr16") {
            const v = evaluate(op.expr, symbols, pc, pass === 2) & 0xFFFF;
            row.bytes.push(v >> 8, v & 0xFF); row.notes.push("addr16 = " + hex4(v) + "h → " + hex2(v >> 8) + "h " + hex2(v) + "h");
          }
        });
        listing.push(row);
        pc = next;   // adres sayacı komut uzunluğu kadar ilerler
      } catch (msg) {
        if (pass === 2 && !errors.some(e => e.line === k + 1)) errors.push({ line: k + 1, msg: String(msg) });
        if (pass === 1 && String(msg).startsWith("Aynı etiket")) errors.push({ line: k + 1, msg: String(msg) });
      }
    }
  }
  if (!errors.length && !listing.some(r => r.bytes.length)) errors.push({ line: 1, msg: "Hiç komut yok." });
  return { ok: errors.length === 0, errors, listing, symbols };
}
