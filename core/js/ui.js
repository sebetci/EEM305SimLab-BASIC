/**
 * @file        core/js/ui.js
 * @summary     Ekran: düğmeleri assembler ve emülatör fonksiyonlarına bağlar ve tabloları çizer.
 * @description Bu dosya hiçbir hesap yapmaz. Düğmeye basılınca ilgili fonksiyonu çağırır
 *              (assemble, loadProgram, resetCpu, fetch, decode, execute) ve ardından ekranı yeniden çizer.
 *
 *              Aşamalar sırayla açılır:
 *                Derle → (başarılıysa) Flash'a Yükle → Reset → Getir → Çöz → Yürüt → Getir → …
 *              Kaynak kod değiştirilirse her şey kapanır ve yeniden derlemek gerekir.
 *
 * @author      Sercan Sebetçi <sercan.sebetci@ogr.sakarya.edu.tr>
 * @copyright   2026 Sercan Sebetçi
 * @license     MIT
 * @version     1.0.0 (2026-11-15)
 */

/** `document.getElementById` kısaltması. @param {string} id @returns {HTMLElement} */
const $ = id => document.getElementById(id);

/**
 * Örnek programlar.
 * @type {Array<{name: string, code: string}>}
 */
const EXAMPLES = [
  { name: "1 · Toplama ve port çıkışı", code:
`; A'ya 05h yükle, 03h ekle; sonucu R0'a ve P1 portuna yaz
        ORG   0000h
        MOV   A,#05h
        ADD   A,#03h
        MOV   R0,A
        MOV   P1,A
        SJMP  $          ; programın sonu: kendine atlar
        END
` },
  { name: "2 · DJNZ ile döngü", code:
`; A'ya 3 kez 02h ekle (R7 sayaç), sonucu RAM 30h'ye yaz
        ORG   0000h
        MOV   R7,#03h
        CLR   A
Loop:   ADD   A,#02h
        DJNZ  R7,Loop    ; R7 ← R7 − 1; sıfır değilse Loop'a dön
        MOV   30h,A
        SJMP  $
        END
` },
  { name: "3 · Alt program (LCALL / RET)", code:
`; Alt programa git, stack'e dönüş adresinin yazılmasını izle
        ORG   0000h
        MOV   A,#10h
        LCALL Topla      ; dönüş adresi stack'e (RAM 08h, 09h)
        MOV   P1,A
        SJMP  $
Topla:  ADD   A,#05h
        RET              ; dönüş adresi stack'ten PC'ye
        END
` },
  { name: "4 · Dolaylı adresleme ve stack", code:
`; R0'ın gösterdiği RAM hücresine yaz, oku; A'yı stack üzerinden B'ye taşı
        ORG   0000h
        MOV   R0,#40h
        MOV   @R0,#0AAh  ; RAM[R0] = RAM[40h] ← AAh
        MOV   A,@R0
        PUSH  ACC        ; ACC = E0h (doğrudan adres)
        POP   B          ; B   = F0h
        SJMP  $
        END
` }
];

/**
 * Uygulamanın durumu.
 * @type {{cpu: Cpu, asm: ?AsmResult, stage: number, phase: string, halted: boolean, error: string, history: Object[], action: ?{title: string, fn: string}}}
 *  - stage: 0 derlenmedi · 1 derlendi · 2 flash'a yüklendi · 3 reset yapıldı (simülasyon açık)
 *  - phase: sıradaki aşama: "fetch" | "decode" | "execute"
 */
const app = { cpu: createCpu(), asm: null, stage: 0, phase: "fetch", halted: false, error: "", history: [], action: null };

// === Düğme işlemleri ===

/**
 * Bir simülasyon aşamasını çalıştırır; öncesinde "Geri" için durumu saklar.
 * @param {string} title - Aşamanın adı.
 * @param {string} fn - Çağrılan fonksiyon (ekranda gösterilir).
 * @param {function(): void} work - Asıl iş.
 * @returns {void}
 */
function runStage(title, fn, work) {
  app.history.push({ cpu: snapshot(app.cpu), stage: app.stage, phase: app.phase, halted: app.halted, error: app.error, action: app.action });
  app.error = "";
  app.action = { title, fn };
  try { work(); } catch (msg) { app.error = String(msg); app.halted = true; }
  render();
}

/** 1 · Derle: assembler.js → assemble(). */
function onCompile() {
  app.asm = assemble($("src").value);
  app.history = [];
  app.halted = false;
  app.cpu = createCpu();
  app.stage = app.asm.ok ? 1 : 0;
  app.phase = "fetch";
  app.error = "";
  app.action = { title: "Derleme", fn: "assembler.js · assemble()" };
  app.cpu.log = app.asm.ok
    ? ["1. geçiş: satırların adresleri ve etiketler bulundu (sembol tablosu).",
       "2. geçiş: her satırın opcode'u opcode tablosundan (opcodes.js) alındı, operandlar byte'a çevrildi.",
       "Sonuç: derleme listesi. Byte'lar henüz flash'ta DEĞİL; sıradaki aşama: Flash'a Yükle."]
    : ["Derleme hatalı; hataları düzeltip yeniden derleyin."];
  render();
}

/** 2 · Flash'a yükle: emulator.js → loadProgram(). */
function onLoad() {
  runStage("Flash'a yükleme", "emulator.js · loadProgram()", () => { loadProgram(app.cpu, app.asm.listing); app.stage = 2; app.phase = "fetch"; app.halted = false; });
}

/** 3 · Reset: emulator.js → resetCpu(). */
function onReset() {
  runStage("Reset", "emulator.js · resetCpu()", () => { resetCpu(app.cpu); app.stage = 3; app.phase = "fetch"; app.halted = false; });
}

/** 4 · Getir: emulator.js → fetch(). */
function onFetch() {
  runStage("Getir (fetch)", "emulator.js · fetch()", () => { fetch(app.cpu); app.phase = "decode"; });
}

/** 5 · Çöz: emulator.js → decode(). */
function onDecode() {
  runStage("Çöz (decode)", "emulator.js · decode()", () => { decode(app.cpu); app.phase = "execute"; });
}

/** 6 · Yürüt: emulator.js → execute(). */
function onExec() {
  runStage("Yürüt (execute)", "emulator.js · execute()", () => { app.halted = execute(app.cpu); app.phase = "fetch"; });
}

/**
 * Tam adım: kalan aşamaları (getir, çöz, yürüt) arka arkaya çalıştırır.
 * Üç aşamanın açıklamaları tek listede, başlıklarıyla birlikte gösterilir.
 */
function onStep() {
  const all = [];
  [["fetch", onFetch, "— GETİR · fetch() —"], ["decode", onDecode, "— ÇÖZ · decode() —"], ["execute", onExec, "— YÜRÜT · execute() —"]].forEach(([ph, fn, title]) => {
    if (app.phase !== ph || app.halted) return;
    fn();
    all.push(title, ...app.cpu.log);
  });
  app.cpu.log = all;
  app.action = { title: "Tam adım", fn: "fetch() → decode() → execute()" };
  renderLog();
}

/** Geri: bir önceki aşamanın durumuna döner. */
function onBack() {
  const h = app.history.pop();
  if (!h) return;
  restore(app.cpu, h.cpu);
  Object.assign(app, { stage: h.stage, phase: h.phase, halted: h.halted, error: h.error, action: h.action });
  if (app.stage < 2) app.cpu.flash.fill(0xFF);   // yüklemeden önceye dönüldüyse flash boşaltılır
  render();
}

/** Kaynak kod değişince her aşama kapanır. */
function onEdit() {
  if (app.stage === 0 && !app.asm) return;
  app.asm = null; app.stage = 0; app.history = []; app.halted = false; app.error = "";
  app.cpu = createCpu(); app.action = null;
  render();
}

// === Ekranı çizme ===

/** Bütün ekranı yeniden çizer. @returns {void} */
function render() {
  renderButtons(); renderErrors(); renderListing(); renderDecode(); renderLog(); renderRegs(); renderFlash(); renderRam();
}

/** Düğmeleri açar/kapatır ve sıradaki aşamayı vurgular. @returns {void} */
function renderButtons() {
  const sim = app.stage === 3 && !app.halted;
  const can = { bCompile: true, bLoad: app.stage >= 1, bReset: app.stage >= 2,
    bFetch: sim && app.phase === "fetch", bDecode: sim && app.phase === "decode", bExec: sim && app.phase === "execute",
    bStep: sim, bBack: app.history.length > 0 };
  Object.keys(can).forEach(id => { $(id).disabled = !can[id]; });
  const next = app.stage === 0 ? "stCompile" : app.stage === 1 ? "stLoad" : app.stage === 2 ? "stReset" : app.halted ? "" : { fetch: "stFetch", decode: "stDecode", execute: "stExec" }[app.phase];
  ["stCompile", "stLoad", "stReset", "stFetch", "stDecode", "stExec"].forEach((id, k) => {
    $(id).classList.toggle("next", id === next);
    $(id).classList.toggle("done", k < 3 && app.stage > k);
  });
}

/** Derleme hatalarını ya da başarı mesajını gösterir. @returns {void} */
function renderErrors() {
  if (!app.asm) { $("errors").innerHTML = ""; return; }
  $("errors").innerHTML = app.asm.ok
    ? '<div class="ok">Derleme başarılı: ' + app.asm.listing.reduce((s, r) => s + r.bytes.length, 0) + " byte makine kodu üretildi.</div>"
    : app.asm.errors.map(e => "<div>Satır " + e.line + ": " + esc(e.msg) + "</div>").join("");
}

/** Derleme listesini (adres, makine kodu, kaynak, kodlama) çizer. @returns {void} */
function renderListing() {
  if (!app.asm || !app.asm.ok) { $("listing").innerHTML = '<tr><td class="muted">Önce "Derle" düğmesine basın.</td></tr>'; $("symbols").textContent = ""; return; }
  const c = app.cpu, running = app.stage === 3;
  $("listing").innerHTML = "<tr><th>Adres</th><th>Makine kodu</th><th>Kaynak</th><th>Kodlama</th></tr>" +
    app.asm.listing.map(r => {
      const isCur = running && c.ir.length && r.bytes.length && r.addr === c.irAddr;
      const isPc = running && r.bytes.length && r.addr === c.pc;
      return '<tr class="' + (isCur ? "cur " : "") + (isPc ? "pcRow" : "") + '"><td>' + (r.addr !== null ? hex4(r.addr) + "h" : "") + "</td><td><b>" +
        r.bytes.map(hex2).join(" ") + "</b></td><td>" + esc((r.label ? r.label + ": " : "") + r.src) + '</td><td class="notes">' + r.notes.map(esc).join("<br>") + "</td></tr>";
    }).join("");
  const syms = Object.keys(app.asm.symbols);
  $("symbols").innerHTML = syms.length ? "<b>Sembol tablosu (1. geçiş):</b> " + syms.map(k => k + " = " + hex4(app.asm.symbols[k]) + "h").join(" · ") : "";
}

/** IR'yi ve çözülen komutu gösterir. @returns {void} */
function renderDecode() {
  const c = app.cpu;
  if (app.stage < 3 || !c.ir.length) { $("decode").innerHTML = '<span class="muted">"Getir" ile flash\'tan bir komut okunduğunda burada görünür.</span>'; return; }
  const entry = OPCODE_TABLE[c.ir[0]];
  let h = '<div class="irBytes">' + c.ir.map((b, k) => '<div class="byte"><small>flash[' + hex4(c.irAddr + k) + "h]</small><b>" + hex2(b) + "h</b><small>" + bin8(b) + "</small><small>" +
    (k === 0 ? "opcode" : "operand " + k) + "</small></div>").join("") + "</div>";
  if (!c.decoded) h += '<div class="muted">IR dolu; henüz çözülmedi. Sıradaki aşama: Çöz.</div>';
  else {
    h += '<div>Opcode tablosu: <span class="fmt">' + entry.fmt + "</span> · " + entry.len + " byte</div>";
    h += '<div>Çözülen komut: <span class="fmt">' + esc(c.decoded.text) + "</span></div>";
  }
  $("decode").innerHTML = h;
}

/** Son aşamada ne olduğunu listeler. @returns {void} */
function renderLog() {
  $("logTitle").innerHTML = app.action ? "Bu Aşamada Ne Oldu? <code>" + app.action.fn + "</code>" : "Bu Aşamada Ne Oldu?";
  const items = app.cpu.log.map(x => "<li>" + esc(x) + "</li>");
  if (app.error) items.push('<li class="err">' + esc(app.error) + "</li>");
  if (app.halted && !app.error) items.push('<li class="halt">Program sona erdi. "Geri" ile önceki adımlara, "Reset" ile başa dönebilirsiniz.</li>');
  $("log").innerHTML = items.join("") || '<li class="muted">Henüz bir işlem yapılmadı.</li>';
}

/** Register tablosunu çizer: ad, adres, onaltılık ve ikilik değer. @returns {void} */
function renderRegs() {
  const c = app.cpu, ch = c.changed;
  const row = (name, addr, val, bits, changed, note) => '<tr class="' + (changed ? "chg" : "") + '"><td>' + name + "</td><td>" + addr + '</td><td class="v">' + val + '</td><td class="bits">' + bits + (note ? " · " + note : "") + "</td></tr>";
  const s = a => c.sfr[a];
  const psw = s(0xD0);
  let h = "<tr><th>Register</th><th>Adres</th><th>Değer</th><th>İkilik / not</th></tr>";
  h += row("PC", "—", hex4(c.pc) + "h", "16 bit, SFR değil", ch.pc, "sıradaki okunacak byte");
  h += row("IR", "—", c.ir.length ? c.ir.map(hex2).join(" ") : "—", "getirilen komut", ch.ir);
  h += row("A (ACC)", "E0h", hex2(s(0xE0)) + "h", bin8(s(0xE0)), ch.sfr224);
  h += row("B", "F0h", hex2(s(0xF0)) + "h", bin8(s(0xF0)), ch.sfr240);
  h += row("PSW", "D0h", hex2(psw) + "h", "CY=" + (psw >> 7 & 1) + " AC=" + (psw >> 6 & 1) + " RS=" + (psw >> 3 & 3) + " OV=" + (psw >> 2 & 1) + " P=" + (psw & 1), ch.sfr208);
  h += row("SP", "81h", hex2(s(0x81)) + "h", bin8(s(0x81)), ch.sfr129, "stack tepesi");
  h += row("DPTR", "83h:82h", hex2(s(0x83)) + hex2(s(0x82)) + "h", "DPH:DPL", ch.sfr131 || ch.sfr130);
  [["P0", 0x80], ["P1", 0x90], ["P2", 0xA0], ["P3", 0xB0]].forEach(([n, a]) => { h += row(n, hex2(a) + "h", hex2(s(a)) + "h", bin8(s(a)), ch["sfr" + a]); });
  for (let n = 0; n < 8; n++) { const a = rAddr(c, n); h += row("R" + n, hex2(a) + "h (RAM)", hex2(c.ram[a]) + "h", bin8(c.ram[a]), ch["ram" + a]); }
  $("regs").innerHTML = h;
}

/** Flash'ın programın bulunduğu bölümünü çizer. @returns {void} */
function renderFlash() {
  const c = app.cpu;
  if (app.stage < 2) { $("flash").innerHTML = '<tr><td class="muted">Flash boş. "Flash\'a Yükle" ile makine kodu buraya yazılır.</td></tr>'; return; }
  const used = app.asm.listing.filter(r => r.bytes.length);
  const lo = Math.min(...used.map(r => r.addr)) & 0xFFF0, hi = Math.max(...used.map(r => r.addr + r.bytes.length - 1));
  const end = Math.min(Math.max(hi | 0x0F, lo + 0x1F), lo + 0xFF);   // en az 2, en fazla 16 satır
  const inIr = a => app.stage === 3 && c.ir.length && a >= c.irAddr && a < c.irAddr + c.ir.length;
  let h = "<tr><th></th>" + [...Array(16)].map((_, k) => "<th>" + k.toString(16).toUpperCase() + "</th>").join("") + "</tr>";
  for (let r = lo; r <= end; r += 16) {
    h += "<tr><th>" + hex4(r) + "</th>";
    for (let k = 0; k < 16; k++) {
      const a = r + k, v = c.flash[a];
      const cls = [v === 0xFF ? "empty" : "", inIr(a) ? "ir" : "", app.stage === 3 && a === c.pc ? "pc" : "", c.changed["flash" + a] ? "chg" : ""].join(" ");
      h += '<td class="' + cls + '" title="' + hex4(a) + 'h">' + hex2(v) + "</td>";
    }
    h += "</tr>";
  }
  $("flash").innerHTML = h;
}

/** Dahili RAM'i (00h–7Fh) çizer. @returns {void} */
function renderRam() {
  const c = app.cpu, base = bankBase(c), sp = c.sfr[0x81];
  let h = "<tr><th></th>" + [...Array(16)].map((_, k) => "<th>" + k.toString(16).toUpperCase() + "</th>").join("") + "</tr>";
  for (let r = 0; r < 0x80; r += 16) {
    h += "<tr><th>" + hex2(r) + "</th>";
    for (let k = 0; k < 16; k++) {
      const a = r + k;
      const cls = [a >= base && a < base + 8 ? "rn" : "", app.stage === 3 && a === sp ? "sp" : "", c.changed["ram" + a] ? "chg" : ""].join(" ");
      h += '<td class="' + cls + '" title="' + hex2(a) + 'h">' + hex2(c.ram[a]) + "</td>";
    }
    h += "</tr>";
  }
  $("ram").innerHTML = h;
}

/** HTML'e güvenli yazmak için `&` ve `<` kaçışlanır. @param {*} x @returns {string} */
const esc = x => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// === Başlangıç ===
EXAMPLES.forEach((e, k) => { const o = document.createElement("option"); o.value = k; o.textContent = e.name; $("selExample").appendChild(o); });
$("selExample").onchange = () => { const k = $("selExample").value; if (k === "") return; $("src").value = EXAMPLES[k].code; $("selExample").value = ""; onEdit(); };
$("src").value = EXAMPLES[0].code;
$("src").oninput = onEdit;
$("bCompile").onclick = onCompile; $("bLoad").onclick = onLoad; $("bReset").onclick = onReset;
$("bFetch").onclick = onFetch; $("bDecode").onclick = onDecode; $("bExec").onclick = onExec;
$("bStep").onclick = onStep; $("bBack").onclick = onBack;
render();
