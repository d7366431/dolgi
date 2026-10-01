// ---------- Engine (shared by page and tests) ----------
const ENG = (() => {
  const mkey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  const parseM = (s) => { const [y, m] = s.split('-').map(Number); return { y, m }; };
  const addM = (s, k) => { const { y, m } = parseM(s); const t = y * 12 + (m - 1) + k; return mkey(Math.floor(t / 12), (t % 12) + 1); };
  const diffM = (a, b) => { const A = parseM(a), B = parseM(b); return (B.y * 12 + B.m) - (A.y * 12 + A.m); };
  const r2 = (x) => Math.round(x * 100) / 100;

  // ---------- salary model ----------
  const BR_BASE = [[2.4e6, 0.13], [5e6, 0.15], [20e6, 0.18], [50e6, 0.20], [Infinity, 0.22]];
  const BR_RK = [[5e6, 0.13], [Infinity, 0.15]];
  function progTax(ytd, inc, br) {
    let tax = 0, lo = ytd, rest = inc;
    for (const [lim, rate] of br) { if (rest <= 0) break; if (lo >= lim) continue; const part = Math.min(rest, lim - lo); tax += part * rate; lo += part; rest -= part; }
    return tax;
  }
  // accrual-month nets: facts (payslips) where available, model afterwards
  function accrualSeries(state, fromM, toM) {
    const sm = state.salary || {}; const coef = ((+sm.rk || 0) + (+sm.sn || 0)) / 100;
    const facts = {}; for (const r of state.payroll || []) facts[r.m] = r;
    const out = {};
    let year = null, yb = 0, yr = 0, ok = +sm.oklad || 0;
    const anchor = sm.ytdMonth || addM(fromM, -1);
    let m = anchor; year = parseM(anchor).y; yb = +sm.ytdBase || 0; yr = +sm.ytdRk || 0;
    for (const k in facts) { const f = facts[k]; if (k >= fromM && k <= anchor && !f.partial) out[k] = { m: k, net: f.net, reg: f.net - (f.bonusNet || 0), bonus: f.bonusNet || 0, adv: (f.adv || 0) + (f.pre || 0), fin: f.fin, fact: true }; }
    // walk from anchor+1 to toM
    for (m = addM(anchor, 1); m <= toM; m = addM(m, 1)) {
      const { y, m: mm } = parseM(m);
      if (y !== year) { year = y; yb = 0; yr = 0; }
      if (mm === (+sm.indexMonth || 7) && +sm.indexPct) ok = ok * (1 + (+sm.indexPct) / 100);
      const hou = sm.housingOn === false ? 0 : (+sm.housing || 0);
      let bb = 0;
      if (sm.bonusesOn !== false) {
        if ((sm.qMonths || []).includes(mm)) bb += (+sm.qPct || 0) / 100 * 3 * ok;
        if (mm === (+sm.y1Month || 0)) bb += (+sm.y1Mult || 0) * ok;
        if (mm === (+sm.y2Month || 0)) bb += (+sm.y2Mult || 0) * ok;
      }
      const regB = ok + hou, regR = ok * coef;
      const netReg = regB + regR - progTax(yb, regB, BR_BASE) - progTax(yr, regR, BR_RK);
      const allB = regB + bb, allR = regR + bb * coef;
      const net = allB + allR - progTax(yb, allB, BR_BASE) - progTax(yr, allR, BR_RK);
      const f = facts[m];
      if (f && !f.partial) {
        out[m] = { m, net: f.net, reg: f.net - (f.bonusNet || 0), bonus: f.bonusNet || 0, adv: (f.adv || 0) + (f.pre || 0), fin: f.fin, fact: true };
        yb += f.tb || 0; yr += f.trk || 0;
      } else {
        const adv = f && f.partial ? (f.fin || 0) + (f.adv || 0) : netReg * (+sm.advPct || 45) / 100;
        out[m] = { m, net, reg: netReg, bonus: net - netReg, adv, fin: Math.max(0, net - adv), fact: false, partial: !!(f && f.partial), oklad: ok };
        yb += allB; yr += allR;
      }
    }
    return out;
  }
  // cash-basis income per calendar month: final of previous month (+bonus) + advance of this month + one-offs
  function incomeSchedule(state, start, n) {
    const acc = accrualSeries(state, addM(start, -1), addM(start, n));
    const rows = [];
    for (let t = 0; t < n; t++) {
      const m = addM(start, t), prev = acc[addM(m, -1)] || { fin: 0, bonus: 0, reg: 0, adv: 0 }, cur = acc[m] || { adv: 0 };
      let ev = 0; for (const e of state.events || []) if (e.month === m) ev += +e.amount || 0;
      const bonus = Math.min(prev.fin, Math.max(0, prev.bonus));
      const salary = (prev.fin - bonus) + cur.adv;
      rows.push({ m, salary, bonus, ev, total: salary + bonus + ev, finPrev: prev.fin, adv: cur.adv, accrual: cur });
    }
    return { rows, acc };
  }
  function incomeFor(state, m, opts) { const r = incomeSchedule(state, m, 1).rows[0]; return { salary: r.salary, bonus: opts && opts.bonuses === false ? 0 : r.bonus, ev: r.ev, total: r.salary + (opts && opts.bonuses === false ? 0 : r.bonus) + r.ev }; }
  const fixedTotal = (state) => (state.fixed || []).reduce((a, f) => a + (+f.amount || 0), 0);
  const expensesFor = (state) => fixedTotal(state) + (+state.settings.living || 0);

  function minPayment(d, bal, interest) {
    if (bal <= 0.005) return 0;
    switch (d.kind) {
      case 'card': {
        let p = bal * (+d.minPct || 0) / 100 + (d.plusInterest ? interest : 0);
        p = Math.max(p, +d.minFloor || 0);
        return Math.min(p, bal);
      }
      case 'annuity': case 'fixed': return Math.min(+d.payment || 0, bal);
      case 'deadline': return 0;
      default: return Math.min(+d.payment || 0, bal);
    }
  }

  function order(debts, strategy, threshold, manual) {
    const arr = debts.slice();
    const rate = (d) => +d.rate || 0;
    if (strategy === 'snowball') arr.sort((a, b) => (rate(a) === 0) - (rate(b) === 0) || a._bal - b._bal);
    else if (strategy === 'hybrid') arr.sort((a, b) => {
      const sa = a._bal <= threshold && rate(a) > 0, sb = b._bal <= threshold && rate(b) > 0;
      if (sa !== sb) return sa ? -1 : 1;
      if (sa && sb) return a._bal - b._bal;
      return rate(b) - rate(a) || a._bal - b._bal;
    });
    else if (strategy === 'manual') arr.sort((a, b) => (manual.indexOf(a.id) + 1 || 999) - (manual.indexOf(b.id) + 1 || 999));
    else arr.sort((a, b) => rate(b) - rate(a) || a._bal - b._bal);
    // deadline debts receive extra only at the very end
    return arr.filter(d => d.kind !== 'deadline').concat(arr.filter(d => d.kind === 'deadline'));
  }

  /* simulate:
     opts.start (YYYY-MM), opts.strategy, opts.bonuses (bool), opts.extra (bool: allocate surplus),
     opts.paidThisMonth {debtId: amount} (facts already applied to balances in the start month),
     opts.cash (starting free cash), opts.horizon */
  function simulate(state, opts) {
    const s = state.settings;
    const horizon = opts.horizon || 240;
    const active = state.debts.filter(d => d.status !== 'closed' && (+d.balance || 0) > 0.005);
    const debts = active.map(d => ({ ...d, _bal: +d.balance, _pay: +d.payment || 0 }));
    const prepay = s.prepayMode || 'payment';
    const paidStart = opts.paidThisMonth || {};

    // conservative surplus per month (salary only, minimums only) for deadline reserve
    let consSurplus = opts._cons;
    if (!consSurplus && opts.extra) {
      const base = simulate(state, { ...opts, extra: false, bonuses: false, conservative: true, _cons: [] , horizon: 60});
      consSurplus = base.months.map(r => r.income - r.expenses - r.minTotal);
    }
    consSurplus = consSurplus || [];

    const sched = incomeSchedule(state, opts.start, horizon).rows;
    let cash = (+opts.cash || 0) - Object.values(paidStart).reduce((a, v) => a + (+v || 0), 0);
    const months = [];
    let totalInterest = 0, payoff = null, deficitMonths = [], deadlineMiss = [];
    for (let t = 0; t < horizon; t++) {
      const m = addM(opts.start, t);
      const sr = sched[t] || { salary: 0, bonus: 0, ev: 0 };
      let inc = { salary: sr.salary, bonus: opts.bonuses ? sr.bonus : 0, ev: sr.ev };
      if (opts.conservative) inc = { salary: sr.salary, bonus: 0, ev: Math.min(0, sr.ev) };
      inc.total = inc.salary + inc.bonus + inc.ev;
      const exp = expensesFor(state);
      cash += inc.total - exp;
      const row = { m, income: inc.total, salary: inc.salary, bonus: inc.bonus, ev: inc.ev, expenses: exp, pay: {}, minPay: {}, extraPay: {}, interest: 0, minTotal: 0, extraTotal: 0, bal: {}, reserve: 0, cashEnd: 0, deficit: 0, paidOff: [] };
      // 1) interest + minimums
      for (const d of debts) {
        if (d._bal <= 0.005) continue;
        const r = (+d.rate || 0) / 100 / 12;
        const interest = d._bal * r;
        d._bal += interest; row.interest += interest; totalInterest += interest;
        if (d.kind === 'deadline') continue;
        let mp = minPayment({ ...d, payment: d._pay }, d._bal, interest);
        if (t === 0 && paidStart[d.id]) mp = Math.max(0, mp - paidStart[d.id]);
        mp = Math.min(mp, d._bal);
        d._bal -= mp; cash -= mp; row.minPay[d.id] = mp; row.pay[d.id] = mp; row.minTotal += mp;
      }
      // deadline debts: due in their month (or overdue) — paid from whatever cash there is
      for (const d of debts) {
        if (d.kind !== 'deadline' || d._bal <= 0.005 || !d.deadline || m < d.deadline) continue;
        let need = d._bal;
        if (t === 0 && paidStart[d.id]) need = Math.max(0, need - 0); // balance already reduced by facts
        const p = Math.max(0, Math.min(need, cash));
        d._bal -= p; cash -= p; row.minPay[d.id] = p; row.pay[d.id] = p; row.minTotal += p;
        if (d._bal > 0.5) { row.shortfall = (row.shortfall || 0) + d._bal; if (!deadlineMiss.find(x => x.id === d.id)) deadlineMiss.push({ id: d.id, m, amount: d._bal }); }
      }
      // 2) required cash: buffer + reserve for future deadlines (conservative)
      let required = Math.max(0, +s.buffer || 0);
      if (opts.extra) {
        const dl = debts.filter(d => d.kind === 'deadline' && d._bal > 0.005 && d.deadline && d.deadline > m).sort((a, b) => a.deadline < b.deadline ? -1 : 1);
        let cum = 0, need = 0;
        for (const d of dl) {
          cum += d._bal;
          let fut = 0; const k = diffM(m, d.deadline);
          for (let j = 1; j <= k; j++) fut += Math.max(0, consSurplus[t + j] || 0);
          need = Math.max(need, cum - fut);
        }
        row.reserve = Math.max(0, need);
        required += row.reserve;
      }
      // 3) extra
      if (opts.extra) {
        let extra = cash - required;
        if (extra > 0.5) {
          const live = debts.filter(d => d._bal > 0.005);
          for (const d of order(live, opts.strategy || s.strategy, +s.hybridThreshold || 100000, s.manualOrder || [])) {
            if (extra <= 0.5) break;
            if (d.kind === 'deadline' && live.some(x => x.kind !== 'deadline' && x._bal > 0.005)) continue;
            const before = d._bal;
            const p = Math.min(extra, d._bal);
            d._bal -= p; extra -= p; cash -= p;
            row.extraPay[d.id] = (row.extraPay[d.id] || 0) + p; row.pay[d.id] = (row.pay[d.id] || 0) + p; row.extraTotal += p;
            if (d.kind === 'annuity' && prepay === 'payment' && before > 0 && d._bal > 0.005) d._pay = d._pay * d._bal / before;
          }
        }
      }
      if (cash < -0.5) { row.deficit = -cash; deficitMonths.push(m); }
      for (const d of debts) { if (d._bal < 0.01) { if (d._bal !== 0 && (row.pay[d.id] || 0) > 0) row.paidOff.push(d.id); d._bal = 0; } row.bal[d.id] = d._bal; }
      row.totalBal = debts.reduce((a, d) => a + d._bal, 0);
      row.cashEnd = cash;
      row.reserved = Math.max(0, Math.min(row.reserve, cash));
      months.push(row);
      if (row.totalBal < 0.5 && payoff == null) { payoff = m; break; }
    }
    // payoff month per debt
    const payoffBy = {};
    for (const d of debts) { const i = months.findIndex(r => r.bal[d.id] < 0.5); payoffBy[d.id] = i >= 0 ? months[i].m : null; }
    return { months, payoff, totalInterest, deficitMonths, deadlineMiss, payoffBy, debts: debts.map(d => d.id) };
  }
  return { simulate, order, addM, diffM, mkey, parseM, incomeFor, incomeSchedule, accrualSeries, progTax, fixedTotal, r2 };
})();
if (typeof module !== 'undefined') module.exports = ENG;
// ---------- Payslip (1C "Расчетный лист") parser ----------
const PAYSLIP = (() => {
  const MON = { 'январь': 1, 'февраль': 2, 'март': 3, 'апрель': 4, 'май': 5, 'июнь': 6, 'июль': 7, 'август': 8, 'сентябрь': 9, 'октябрь': 10, 'ноябрь': 11, 'декабрь': 12 };
  const num = (s) => parseFloat(String(s).replace(/\s/g, '').replace(/\./g, '').replace(',', '.'));
  const RK = new Set(['1004', '1005', '1091', '1092', '1093', '1094']);
  function cat(c) {
    if (['0001', '1004', '1005'].includes(c)) return 'sal';
    if (c === '1031') return 'hou';
    if (['0200', '1019', '0202', '1030'].includes(c)) return 'trip';
    if (['2000', '2002', '2003', '1093', '1094'].includes(c)) return 'vac';
    if (['1500', '1033'].includes(c)) return 'sick';
    if (['3002', '3004', '3019', '3018', '1091', '1092'].includes(c)) return 'bon';
    return 'oth';
  }
  // pdf.js text content -> lines (grouped by y, ordered by x, gaps -> spaces)
  async function linesFromPdf(pdfjsLib, data) {
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str) continue;
        const x = it.transform[4], y = it.transform[5];
        let row = rows.find(r => Math.abs(r.y - y) < 2.5);
        if (!row) { row = { y, items: [] }; rows.push(row); }
        row.items.push({ x, s: it.str, w: it.width || 0 });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let line = '', end = null;
        for (const it of r.items) {
          if (end != null) { const gap = it.x - end; line += gap > 12 ? '    ' : gap > 1.5 ? ' ' : ''; }
          line += it.s; end = it.x + it.w;
        }
        out.push(line);
      }
    }
    return out;
  }
  function parse(lines) {
    const text = lines.join('\n');
    const mh = text.match(/РАСЧЕТНЫЙ ЛИСТ ЗА\s+(\S+)\s+(\d{4})/i);
    if (!mh || !MON[mh[1].toLowerCase()]) throw new Error('not_payslip');
    const m = `${mh[2]}-${String(MON[mh[1].toLowerCase()]).padStart(2, '0')}`;
    const g = (re) => { const x = text.match(re); return x ? x[1] : null; };
    const days = num(g(/ОТРАБОТАНО ПО ГРАФИКУ:\s+ДНИ\s+([\d.,]+)/) || '0') || 0;
    const norm = num(g(/НОРМА:\s+ДНИ\s+([\d.,]+)/) || '0') || 0;
    const oklad = num(g(/ОКЛАД:\s+([\d.,]+)/) || '0') || 0;
    let sec = null; const items = [];
    for (const line of lines) {
      if (/Начислено за текущий/.test(line)) { sec = 'acc'; continue; }
      if (/Дополнительный доход/.test(line)) { sec = 'extra'; continue; }
      if (/^\s*Удержано/.test(line)) { sec = 'ded'; continue; }
      if (/^\s*Перечислено/.test(line)) { sec = 'paid'; continue; }
      if (/Справочно/.test(line)) { sec = null; continue; }
      const mm = line.match(/^\s*(\d{2})\/(\d{4})\s+(\S{4})\s+(.+?)\s{2,}.*?([\d.]+,\d{2})(-?)\s*$/) || line.match(/^\s*(\d{2})\/(\d{4})\s+(\S{4})\s+(.+?)\s+([\d.]+,\d{2})(-?)\s*$/);
      if (sec && mm) {
        const amt = num(mm[5]) * (mm[6] ? -1 : 1);
        const base = (line.match(/\s([\d.]+,\d{2})\s/) || [])[1];
        items.push({ sec, per: `${mm[2]}-${mm[1]}`, code: mm[3], name: mm[4].trim(), amt, base: base ? num(base) : null });
      }
    }
    if (!items.length) throw new Error('no_items');
    const acc = items.filter(i => i.sec === 'acc');
    const p = {}; let accTot = 0, tb = 0, trk = 0;
    for (const i of acc) { const k = cat(i.code); p[k] = (p[k] || 0) + i.amt; accTot += i.amt; if (RK.has(i.code)) trk += i.amt; else tb += i.amt; }
    for (const i of items.filter(i => i.sec === 'extra')) tb += i.amt;
    const ded = items.filter(i => i.sec === 'ded');
    const ndfl = ded.filter(i => /^(Y3|XD)/.test(i.code)).reduce((a, i) => a + i.amt, 0);
    const otherDed = ded.filter(i => /^72/.test(i.code)).reduce((a, i) => a + i.amt, 0);
    const advance = ded.filter(i => ['8006', '8011'].includes(i.code)).reduce((a, i) => a + i.amt, 0);
    const prepaid = ded.filter(i => /^80/.test(i.code) && !['8006', '8011'].includes(i.code)).reduce((a, i) => a + i.amt, 0);
    const final = items.filter(i => i.sec === 'paid').reduce((a, i) => a + i.amt, 0);
    const hou = acc.find(i => i.code === '1031' && i.per === m && i.amt > 0);
    const bonuses = acc.filter(i => ['3002', '3004', '3019', '3018'].includes(i.code)).map(i => ({ code: i.code, name: i.name, amt: Math.round(i.amt) }));
    const ytdInc = num(g(/Совокупный доход с начала года\s+([\d.,]+)/) || '0') || null;
    const ytdTax = num(g(/Удержанный НДФЛ с начала года\s+([\d.,]+)/) || '0') || null;
    const r = (x) => Math.round(x);
    const pr = {}; for (const k in p) if (Math.abs(p[k]) > 0.5) pr[k] = r(p[k]);
    return { m, days, norm, oklad: r(oklad), net: r(accTot - ndfl - otherDed), acc: r(accTot), ndfl: r(ndfl), adv: r(advance), pre: r(prepaid), fin: r(final), tb: r(tb), trk: r(trk), housing: hou ? r(hou.base || hou.amt) : 0, bonuses, ytdInc: ytdInc ? r(ytdInc) : null, ytdTax: ytdTax ? r(ytdTax) : null, p: pr };
  }
  return { linesFromPdf, parse };
})();
if (typeof module !== 'undefined') module.exports = PAYSLIP;
// ================= APP =================
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const clone = (o) => JSON.parse(JSON.stringify(o));
const MN = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const MD = ['январю','февралю','марту','апрелю','маю','июню','июлю','августу','сентябрю','октябрю','ноябрю','декабрю'];
const MP = ['январе','феврале','марте','апреле','мае','июне','июле','августе','сентябре','октябре','ноябре','декабре'];
const MG = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MS = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const WD = ['вс','пн','вт','ср','чт','пт','сб'];
const PAL = ['#B5475B','#3B5BA5','#C27C0E','#2A8FB8','#7A4FA0','#6B8E23','#8C6A43','#4E6E81','#0F7A62','#C0563A','#5F6B2E','#A0527F'];
const KIND = { card: 'Кредитная карта', annuity: 'Кредит', fixed: 'Рассрочка / фикс. платёж', deadline: 'Заём к сроку' };
const STRATS = {
  avalanche: { name: 'Лавина', text: 'Всё свободное — в долг с самой высокой ставкой. Минимальная переплата.' },
  hybrid: { name: 'Гибрид', text: 'Сначала мелкие долги до порога (быстрые победы), дальше — по ставке.' },
  snowball: { name: 'Снежный ком', text: 'Сначала самый маленький остаток. Переплата выше, зато долги исчезают быстрее по счёту.' },
  manual: { name: 'Свой порядок', text: 'Вы сами задаёте очередь досрочного погашения.' },
};
const fmt = (x) => (Math.round(+x || 0)).toLocaleString('ru-RU') + ' ₽';
const fmtN = (x) => (Math.round(+x || 0)).toLocaleString('ru-RU');
const fmtC = (x) => { x = +x || 0; const a = Math.abs(x); if (a >= 1e6) return (x / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' млн ₽'; if (a >= 1e4) return Math.round(x / 1e3).toLocaleString('ru-RU') + ' тыс. ₽'; return fmt(x); };
const parseNum = (v) => { if (typeof v === 'number') return v; const s = String(v ?? '').replace(/[\s\u00a0₽]/g, '').replace(/[−–]/g, '-').replace(',', '.'); const n = parseFloat(s); return isNaN(n) ? 0 : n; };
const plural = (n, f) => { n = Math.abs(n) % 100; const n1 = n % 10; if (n > 10 && n < 20) return f[2]; if (n1 > 1 && n1 < 5) return f[1]; if (n1 === 1) return f[0]; return f[2]; };
const mName = (m) => { const { y, m: k } = ENG.parseM(m); return MN[k - 1] + ' ' + y; };
const mDat = (m) => { const { y, m: k } = ENG.parseM(m); return MD[k - 1] + ' ' + y; };
const mPrep = (m) => { const { y, m: k } = ENG.parseM(m); return MP[k - 1] + ' ' + y; };
const mShort = (m) => { const { y, m: k } = ENG.parseM(m); return MS[k - 1] + ' ' + String(y).slice(2); };
const mGen = (m) => { const { y, m: k } = ENG.parseM(m); return MG[k - 1] + ' ' + y; };
const dText = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.split('-').map(Number); return d + ' ' + MG[m - 1] + (y !== new Date().getFullYear() ? ' ' + y : ''); };
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const curMonth = () => todayISO().slice(0, 7);
const dim = (m) => { const { y, m: k } = ENG.parseM(m); return new Date(y, k, 0).getDate(); };
function fmtN0(v) { v = +v; if (!isFinite(v)) return ''; const r = Math.round(v * 100) / 100; return r.toLocaleString('ru-RU', { maximumFractionDigits: 2 }); }

// ---------- state ----------
const LS = 'debtplan.state.v2';
const DEFAULT = () => ({
  version: 2, updatedAt: 0,
  settings: { living: 100000, buffer: 50000, cashNow: 0, strategy: 'avalanche', hybridThreshold: 100000, prepayMode: 'payment', bonusesInPlan: true, manualOrder: [] },
  salary: { oklad: 0, rk: 0, sn: 0, housing: 0, housingOn: false, qPct: 0, qMonths: [], y1Month: 3, y1Mult: 0, y2Month: 7, y2Mult: 0, indexMonth: 7, indexPct: 0, advPct: 45, advDay: 25, salDay: 10, ytdMonth: null, ytdBase: 0, ytdRk: 0 },
  fixed: [], events: [], debts: [], payments: [], history: [], baseline: null, payroll: [], payrollNotes: [], tx: [], rules: [],
});
function normalize(s) {
  const d = DEFAULT();
  s = Object.assign(d, s || {});
  s.settings = Object.assign(DEFAULT().settings, s.settings || {});
  s.salary = Object.assign(DEFAULT().salary, s.salary || {});
  for (const k of ['fixed', 'events', 'debts', 'payments', 'history', 'payroll', 'payrollNotes', 'tx', 'rules']) if (!Array.isArray(s[k])) s[k] = [];
  // migrate v1 (flat income + rent)
  if (s.settings.income && !s.salary.oklad) { s.salary.oklad = Math.round(s.settings.income / 2.2 / 0.87); s.salary.rk = 70; s.salary.sn = 50; }
  if (s.settings.rent && !s.fixed.length) s.fixed.push({ id: uid(), name: 'Аренда', amount: s.settings.rent, day: 1 });
  delete s.settings.income; delete s.settings.rent; delete s.bonuses;
  s.debts.forEach((x, i) => { if (!x.id) x.id = uid(); if (!x.color) x.color = PAL[i % PAL.length]; if (!x.status) x.status = 'active'; });
  s.events.forEach(e => { if (!e.id) e.id = uid(); });
  s.fixed.forEach(e => { if (!e.id) e.id = uid(); });
  return s;
}
let S = DEFAULT();
try { const raw = localStorage.getItem(LS); if (raw) S = normalize(JSON.parse(raw)); } catch (e) {}
const hasData = (s) => s && (s.debts.length > 0 || s.payments.length > 0 || s.payroll.length > 0);

// ---------- crypto (data is encrypted on the device before it leaves it) ----------
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('debtplan', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function kvGet(k) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch (e) { return null; } }
async function kvSet(k, v) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} }
async function kvDel(k) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} }
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptState(key, salt, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}
async function decryptState(key, payload) {
  const p = JSON.parse(payload);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p.iv) }, key, unb64(p.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------- Supabase (plain REST, no SDK) ----------
const CFG = window.APP_CONFIG || {};
const SB = (CFG.supabaseUrl || '').replace(/\/+$/, ''), SBK = CFG.supabaseAnonKey || '';
const cloudConfigured = !!(SB && SBK);
const SESS = 'debtplan.session';
let session = null; try { session = JSON.parse(localStorage.getItem(SESS) || 'null'); } catch (e) {}
let cryptoKey = null, cryptoSalt = null;
let sync = { state: 'local', at: null, msg: '' }; // local | ok | syncing | offline | error | login | unlock
let localOnly = localStorage.getItem('debtplan.localOnly') === '1';
async function sbAuth(path, body) {
  const r = await fetch(SB + '/auth/v1/' + path, { method: 'POST', headers: { apikey: SBK, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.msg || j.message || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}
function saveSession(j) {
  session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: { id: j.user.id, email: j.user.email } };
  localStorage.setItem(SESS, JSON.stringify(session));
}
async function token() {
  if (!session) throw new Error('no_session');
  if (Date.now() > session.expires_at - 60000) {
    try { saveSession(await sbAuth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })); }
    catch (e) { if (e.status === 400 || e.status === 401) { session = null; localStorage.removeItem(SESS); setSync('login'); } throw e; }
  }
  return session.access_token;
}
async function sbRest(method, query, body, prefer) {
  const t = await token();
  const r = await fetch(SB + '/rest/v1/app_state' + (query || ''), { method, headers: Object.assign({ apikey: SBK, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, prefer ? { Prefer: prefer } : {}), body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
async function pullRemote() {
  const rows = await sbRest('GET', '?select=payload,updated_at&user_id=eq.' + session.user.id);
  return rows && rows[0] ? rows[0] : null;
}
let pushing = false, pushAgain = false;
async function pushRemote() {
  if (!cloudConfigured || !session || !cryptoKey || localOnly) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true; setSync('syncing');
  try {
    do {
      pushAgain = false;
      const payload = await encryptState(cryptoKey, cryptoSalt, S);
      await sbRest('POST', '?on_conflict=user_id', { user_id: session.user.id, payload, updated_at: S.updatedAt }, 'resolution=merge-duplicates,return=minimal');
      localStorage.setItem('debtplan.lastSynced', String(S.updatedAt));
    } while (pushAgain);
    setSync('ok');
  } catch (e) { setSync(navigator.onLine ? 'error' : 'offline', e.message); }
  pushing = false;
}
async function pullAndMerge() {
  if (!cloudConfigured || !session || !cryptoKey || localOnly) return;
  try {
    setSync('syncing');
    const row = await pullRemote();
    if (row) {
      if ((row.updated_at || 0) > (S.updatedAt || 0)) {
        const remote = await decryptState(cryptoKey, row.payload);
        S = normalize(remote); try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {}
        localStorage.setItem('debtplan.lastSynced', String(S.updatedAt));
        renderAll(); setSync('ok');
      } else if ((row.updated_at || 0) < (S.updatedAt || 0)) await pushRemote();
      else setSync('ok');
    } else await pushRemote();
  } catch (e) { setSync(navigator.onLine ? 'error' : 'offline', e.message); }
}
function setSync(state, msg) { sync = { state, at: state === 'ok' ? new Date() : sync.at, msg: msg || '' }; renderSync(); if (state === 'login' || state === 'unlock') renderGate(); }
function syncText() {
  switch (sync.state) {
    case 'ok': return 'Синхронизировано ' + (sync.at ? sync.at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');
    case 'syncing': return 'Синхронизация…';
    case 'offline': return 'Нет связи — изменения сохранены на устройстве';
    case 'error': return 'Не удалось синхронизировать — данные сохранены на устройстве' + (sync.msg ? ' (' + sync.msg + ')' : '');
    case 'login': case 'unlock': return 'Нужен вход';
    default: return cloudConfigured ? 'Только на этом устройстве' : 'Только на этом устройстве (облако не настроено)';
  }
}
function renderSync() { const el = $('#syncState'); if (el) { el.className = 'sync' + (sync.state === 'ok' ? ' on' : sync.state === 'error' ? ' err' : ''); el.innerHTML = '<i></i>' + esc(syncText()); } }

function persistNow() {
  S.updatedAt = Date.now();
  try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {}
  pushRemote();
}
let persistT = null;
function persist(delay = 700) { clearTimeout(persistT); persistT = setTimeout(persistNow, delay); }

// ---------- gate: login / unlock ----------
function gateNeeded() {
  if (!cloudConfigured || localOnly) return null;
  if (!session) return 'login';
  if (!cryptoKey) return 'unlock';
  return null;
}
function renderGate() {
  const g = $('#gate'); const need = gateNeeded();
  if (!need) { g.hidden = true; $('#app').hidden = false; return; }
  g.hidden = false; $('#app').hidden = true;
  if (need === 'login') {
    g.innerHTML = `<div class="gate-card"><h1>План погашения долгов</h1><p class="sub">Войдите, чтобы данные синхронизировались между телефоном и компьютером.</p>
      <form id="loginForm" class="form1"><label class="field"><span>Почта</span><input type="email" name="email" autocomplete="username" required></label>
      <label class="field"><span>Пароль</span><input type="password" name="password" autocomplete="current-password" required minlength="8"></label>
      <p class="neg small" id="loginErr"></p>
      <div class="row-actions"><button class="btn primary" value="in">Войти</button><button class="btn" value="up">Зарегистрироваться</button></div></form>
      <p class="sub small" style="margin-top:16px">Регистрация нужна один раз, на первом устройстве. Потом её стоит выключить в настройках Supabase — так зарегистрироваться больше никто не сможет.</p>
      <button class="btn ghost" type="button" id="goLocal">Работать без входа, только на этом устройстве</button></div>`;
    $('#goLocal').onclick = () => { localOnly = true; localStorage.setItem('debtplan.localOnly', '1'); setSync('local'); renderGate(); renderAll(); };
    $('#loginForm').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target, mode = e.submitter && e.submitter.value; const err = $('#loginErr'); err.textContent = '';
      const body = { email: f.email.value.trim(), password: f.password.value };
      try {
        if (mode === 'up') {
          const j = await sbAuth('signup', body);
          if (!j.access_token) { err.textContent = 'Аккаунт создан. Подтвердите почту по ссылке из письма и войдите.'; return; }
          saveSession(j);
        } else saveSession(await sbAuth('token?grant_type=password', body));
        await afterLogin();
      } catch (ex) { err.textContent = /invalid login/i.test(ex.message) ? 'Неверная почта или пароль.' : /signups not allowed/i.test(ex.message) ? 'Регистрация выключена. Войдите существующим аккаунтом.' : /failed to fetch|networkerror|load failed/i.test(ex.message) ? 'Нет связи с Supabase. Проверьте интернет и адрес проекта в config.js.' : 'Не получилось: ' + ex.message; }
    };
  } else {
    g.innerHTML = `<div class="gate-card"><h1>Пароль шифрования</h1><p class="sub" id="unlockText">Проверяю данные в облаке…</p>
      <form id="unlockForm" class="form1" hidden><label class="field"><span>Пароль шифрования</span><input type="password" name="pass" required minlength="8" autocomplete="new-password"></label>
      <label class="field" id="pass2Wrap" hidden><span>Повторите пароль</span><input type="password" name="pass2" autocomplete="new-password"></label>
      <p class="neg small" id="unlockErr"></p><div class="row-actions"><button class="btn primary">Продолжить</button><button class="btn ghost" type="button" id="logoutBtn">Выйти</button></div></form></div>`;
    $('#logoutBtn').onclick = signOut;
    (async () => {
      let row = null;
      try { row = await pullRemote(); } catch (e) { $('#unlockText').textContent = 'Нет связи с облаком. Попробуйте позже или работайте без входа.'; return; }
      const isNew = !row;
      $('#unlockText').textContent = isNew
        ? 'Придумайте пароль шифрования. Данные шифруются на устройстве, и без этого пароля их не прочитает никто — ни хостинг, ни вы сами. Запишите его: восстановить его нельзя. Он может отличаться от пароля входа.'
        : 'Введите пароль шифрования, который вы задали на первом устройстве. Вводить его нужно один раз на каждом устройстве.';
      $('#unlockForm').hidden = false; $('#pass2Wrap').hidden = !isNew; if (isNew) $('#unlockForm').pass2.required = true;
      $('#unlockForm').onsubmit = async (e) => {
        e.preventDefault(); const f = e.target, err = $('#unlockErr'); err.textContent = '';
        if (isNew && f.pass.value !== f.pass2.value) { err.textContent = 'Пароли не совпадают.'; return; }
        const salt = isNew ? crypto.getRandomValues(new Uint8Array(16)) : unb64(JSON.parse(row.payload).salt);
        const key = await deriveKey(f.pass.value, salt);
        if (!isNew) { try { const remote = await decryptState(key, row.payload); if (!hasData(S) || (row.updated_at || 0) >= (S.updatedAt || 0)) { S = normalize(remote); try { localStorage.setItem(LS, JSON.stringify(S)); } catch (x) {} } } catch (x) { err.textContent = 'Пароль не подходит.'; return; } }
        cryptoKey = key; cryptoSalt = salt; await kvSet('key:' + session.user.id, { key, salt });
        renderGate(); renderAll(); if (isNew) { S.updatedAt = S.updatedAt || Date.now(); await pushRemote(); } else await pullAndMerge();
      };
    })();
  }
}
async function afterLogin() {
  const k = await kvGet('key:' + session.user.id);
  if (k && k.key) { cryptoKey = k.key; cryptoSalt = k.salt; renderGate(); renderAll(); await pullAndMerge(); }
  else setSync('unlock');
}
async function signOut(clearLocal) {
  try { if (session) await fetch(SB + '/auth/v1/logout', { method: 'POST', headers: { apikey: SBK, Authorization: 'Bearer ' + session.access_token } }); } catch (e) {}
  if (session) await kvDel('key:' + session.user.id);
  session = null; cryptoKey = null; localStorage.removeItem(SESS);
  if (clearLocal === true) { localStorage.removeItem(LS); S = DEFAULT(); }
  setSync('login'); renderGate();
}
async function initSync() {
  if (!cloudConfigured || localOnly) { setSync('local'); renderGate(); return; }
  if (!session) { setSync('login'); return; }
  await afterLogin();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullAndMerge(); });
window.addEventListener('online', () => pushRemote());
const loading = false;
// ---------- computations ----------
const activeDebts = () => S.debts.filter(d => d.status !== 'closed');
const debtById = (id) => S.debts.find(d => d.id === id);
const debtName = (id) => (debtById(id) || {}).name || (S.baseline && S.baseline.names && S.baseline.names[id]) || 'Удалённый кредит';
const debtColor = (id) => (debtById(id) || {}).color || '#888';
function factsByMonth() {
  const out = {};
  for (const p of S.payments) { const m = p.date.slice(0, 7); out[m] = out[m] || {}; out[m][p.debtId] = (out[m][p.debtId] || 0) + (+p.amount || 0); }
  return out;
}
function simOpts(extra = {}) {
  const fm = factsByMonth()[curMonth()] || {};
  return Object.assign({ start: curMonth(), strategy: S.settings.strategy, bonuses: !!S.settings.bonusesInPlan, extra: true, cash: +S.settings.cashNow || 0, paidThisMonth: fm, horizon: 240 }, extra);
}
let F = null;
function compute() { F = ENG.simulate(S, simOpts()); return F; }
const totalDebt = () => activeDebts().reduce((a, d) => a + (+d.balance || 0), 0);
function recordHistory() {
  const t = Math.round(totalDebt()); const d = todayISO();
  const last = S.history[S.history.length - 1];
  if (last && last.d === d) last.t = t; else S.history.push({ d, t });
}
function makeBaseline() {
  const f = compute(); const fm = factsByMonth()[curMonth()] || {};
  const rows = f.months.slice(0, 180).map((r, i) => {
    const pay = {}; let tot = 0;
    for (const [k, v] of Object.entries(r.pay)) { const val = Math.round(v + (i === 0 ? (fm[k] || 0) : 0)); if (val > 0) { pay[k] = val; tot += val; } }
    if (i === 0) for (const [k, v] of Object.entries(fm)) if (!(k in pay)) { pay[k] = Math.round(v); tot += Math.round(v); }
    return { m: r.m, pay, payTotal: tot, bal: Math.round(r.totalBal), reserve: Math.round(r.reserve) };
  });
  const names = {}; S.debts.forEach(d => names[d.id] = d.name);
  const sch = ENG.incomeSchedule(S, curMonth(), 18);
  const inc = sch.rows.map(r => ({ m: r.m, acc: Math.round(r.accrual.net || 0), cash: Math.round(r.total) }));
  S.baseline = { createdAt: new Date().toISOString(), start: curMonth(), strategy: S.settings.strategy, payoff: f.payoff, totalInterest: Math.round(f.totalInterest), startTotal: Math.round(totalDebt() + Object.values(fm).reduce((a, v) => a + v, 0)), rows, names, inc };
}

// ---------- UI helpers ----------
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2400); }
const dlg = $('#dlg');
function openDialog(html, foot, onSubmit, onMount) {
  $('#dlgBody').innerHTML = html; $('#dlgFoot').innerHTML = foot;
  dlg._submit = onSubmit; dlg.showModal(); if (onMount) onMount($('#dlgBody'));
}
$('#dlgForm').addEventListener('submit', (e) => {
  const btn = e.submitter; if (!btn || btn.value === 'cancel') return;
  if (dlg._submit) { const ok = dlg._submit(btn.value, $('#dlgBody')); if (ok === false) e.preventDefault(); }
});
const field = (label, input, help) => `<div class="field"><label>${label}</label>${input}${help ? `<div class="help">${help}</div>` : ''}</div>`;
const inText = (name, val, attrs = '') => `<input type="text" name="${name}" value="${esc(val)}" ${attrs}>`;
const inNum = (name, val, attrs = '') => `<input type="text" inputmode="decimal" name="${name}" value="${val === '' || val == null ? '' : esc(fmtN0(val))}" ${attrs}>`;
function fmtN0(v) { v = +v; if (!isFinite(v)) return ''; const r = Math.round(v * 100) / 100; return r.toLocaleString('ru-RU', { maximumFractionDigits: 2 }); }

// ---------- render: hero ----------
function renderHero() {
  const el = $('#hero');
  const act = activeDebts();
  const sync = `<div class="sync" id="syncState"></div>`;
  if (!act.length) {
    el.innerHTML = `<div class="hero-top"><div><h1>${S.debts.length ? 'Долгов <span class="when">нет</span>' : 'Добавьте кредиты'}</h1><p class="lead">${S.debts.length ? 'Все обязательства закрыты. Отличная работа.' : 'Внесите кредиты на вкладке «Кредиты» или загрузите копию данных на вкладке «Бюджет».'}</p></div>${sync}</div>`;
    renderSync(); return;
  }
  const r0 = F.months[0];
  const n = F.payoff ? ENG.diffM(curMonth(), F.payoff) + 1 : null;
  const h1 = F.payoff ? `Без долгов<br>к <span class="when">${mDat(F.payoff)}</span>` : `При текущем бюджете<br>долги <span class="when">не гасятся</span>`;
  const lead = F.payoff ? `Через ${n} ${plural(n, ['месяц', 'месяца', 'месяцев'])} при текущих доходах, расходах и стратегии «${STRATS[S.settings.strategy].name}». Любое изменение данных сразу пересчитывает план.` : 'Обязательные платежи съедают весь свободный остаток. Проверьте доходы, расходы и платежи.';
  const startTotal = S.baseline ? S.baseline.startTotal : null;
  const paidPrincipal = startTotal ? Math.max(0, startTotal - totalDebt()) : 0;
  el.innerHTML = `<div class="hero-top"><div><h1>${h1}</h1><p class="lead">${lead}</p></div>${sync}</div>
  <div class="stats">
    <div class="stat"><b>${fmtC(totalDebt())}</b><span>долг сейчас</span></div>
    <div class="stat"><b>${fmtC(r0.minTotal + r0.extraTotal)}</b><span>заплатить в ${MP[ENG.parseM(r0.m).m - 1]}</span></div>
    <div class="stat"><b>${fmtC(F.totalInterest)}</b><span>проценты до конца плана</span></div>
    <div class="stat"><b>${startTotal ? fmtC(paidPrincipal) : '—'}</b><span>${startTotal ? 'погашено с ' + dText(S.baseline.createdAt.slice(0, 10)) : 'план не зафиксирован'}</span></div>
  </div>`;
  renderSync();
}

// ---------- render: ladder ----------
function renderLadder() {
  const el = $('#ladder');
  const act = activeDebts().filter(d => (+d.balance || 0) > 0);
  if (loading || !act.length) { el.hidden = true; return; }
  el.hidden = false;
  const cm = curMonth();
  const last = F.payoff || F.months[F.months.length - 1].m;
  const N = Math.max(6, ENG.diffM(cm, last) + 1);
  const narrow = (document.documentElement.clientWidth || 1000) < 640;
  const maxLabels = narrow ? 4 : 8; let step = Math.ceil(N / maxLabels); if (step > 1 && step < 3) step = 3; else if (step > 3 && step < 6) step = 6; else if (step > 6) step = 12;
  let axis = '';
  for (let i = 0; i < N; i += step) axis += `<span style="left:${(i + 0.5) / N * 100}%">${mShort(ENG.addM(cm, i))}</span>`;
  const rows = act.map(d => ({ d, p: F.payoffBy[d.id] })).sort((a, b) => (a.p || '9999') < (b.p || '9999') ? -1 : 1);
  const mw = (100 / N).toFixed(4) + '%';
  let html = `<h2>Лестница погашения</h2><p class="hint">Каждая полоса — кредит до месяца, когда он будет закрыт по плану. Треугольник — срок возврата частного займа.</p><div class="lad-grid"><div></div><div class="lad-axis">${axis}</div>`;
  for (const { d, p } of rows) {
    const idx = p ? ENG.diffM(cm, p) : N - 1;
    const w = Math.max(0.5, (idx + 1) / N * 100);
    const endTxt = p ? mShort(p) : 'позже';
    const mark = d.kind === 'deadline' && d.deadline ? `<div class="lad-mark" style="left:${Math.min(100, (ENG.diffM(cm, d.deadline) + 1) / N * 100)}%"></div>` : '';
    const endPos = w > 82 ? `right:${100 - w}%;left:auto;padding-left:0;padding-right:6px;color:#fff;font-weight:600` : `left:${w}%`;
    html += `<div class="lad-name"><span class="dot" style="background:${d.color}"></span>${esc(d.name)}<small>${fmtC(d.balance)}, ${fmtN0(+d.rate || 0)}%</small></div>
      <div class="lad-track" style="--mw:${mw}"><div class="lad-bar" style="width:${w}%;background:${d.color}"></div>${mark}<span class="lad-end" style="${endPos}">${endTxt}</span></div>`;
  }
  el.innerHTML = html + '</div>';
}

// ---------- render: alerts ----------
function renderAlerts() {
  const el = $('#alerts');
  if (loading || !activeDebts().length) { el.innerHTML = ''; return; }
  const out = [];
  for (const miss of F.deadlineMiss) {
    const d = debtById(miss.id); const paidAt = F.payoffBy[miss.id];
    out.push(`<div class="alert danger"><b>К сроку «${esc(d ? d.name : '')}» (${mName(miss.m)}) не хватит около ${fmt(miss.amount)}.</b> Все свободные деньги до срока уже откладываются на него. ${paidAt ? `Остаток можно будет закрыть в ${mPrep(paidAt)}. ` : ''}Варианты: договориться с кредитором о переносе этой части, сократить расходы или добавить ожидаемое поступление на вкладке «Бюджет».</div>`);
  }
  if (F.deficitMonths.length) out.push(`<div class="alert danger"><b>Не хватает на обязательные платежи в ${F.deficitMonths.slice(0, 3).map(mPrep).join(', ')}.</b> Это риск просрочки — проверьте расходы и суммы платежей.</div>`);
  if (S.settings.bonusesInPlan) {
    const nb = ENG.simulate(S, simOpts({ bonuses: false }));
    if (F.payoff && nb.payoff !== F.payoff) out.push(`<div class="alert warn">План опирается на премии. Без них долги закроются ${nb.payoff ? 'к ' + mDat(nb.payoff) : 'значительно позже'}, проценты вырастут на ${fmtC(nb.totalInterest - F.totalInterest)}.</div>`);
  }
  const stale = activeDebts().filter(d => d.balanceDate && (Date.now() - new Date(d.balanceDate).getTime()) > 35 * 864e5);
  if (stale.length) out.push(`<div class="alert warn">Остатки давно не сверялись: ${stale.map(d => esc(d.name)).join(', ')}. Обновите их по приложениям банков на вкладке «Кредиты».</div>`);
  el.innerHTML = out.join('');
}

// ---------- render: this month ----------
function renderMonth() {
  const el = $('#tab-month');
  if (loading) { el.innerHTML = ''; return; }
  if (!activeDebts().length) { el.innerHTML = `<div class="panel empty">Здесь появится список платежей на месяц, как только вы добавите кредиты.<div style="margin-top:12px"><button class="btn primary" data-act="add-debt" type="button">Добавить кредит</button></div></div>`; return; }
  const r = F.months[0]; const cm = curMonth();
  const facts = factsByMonth()[cm] || {};
  const factTotal = Object.values(facts).reduce((a, v) => a + v, 0);
  const inc = Math.max(1, r.salary + r.bonus + Math.max(0, r.ev));
  const flowRow = (label, val, cls = '', bar = null) => `<div class="flow-row ${cls}"><span>${label}</span><span class="num ${val < 0 ? '' : ''}">${val < 0 ? '−' : ''}${fmt(Math.abs(val))}</span>${bar != null ? `<div class="bar"><i style="width:${Math.min(100, Math.max(0, bar * 100))}%;background:${cls.includes('debt') ? 'var(--danger)' : cls.includes('extra') ? 'var(--accent)' : 'var(--ink-3)'}"></i></div>` : ''}</div>`;
  const evIn = (S.events || []).filter(e => e.month === cm && +e.amount > 0).reduce((a, e) => a + +e.amount, 0);
  const evOut = (S.events || []).filter(e => e.month === cm && +e.amount < 0).reduce((a, e) => a - +e.amount, 0);
  const fixedSum = ENG.fixedTotal(S);
  let flow = flowRow('Зарплата: расчёт за прошлый месяц и аванс', r.salary, '', 1);
  if (r.bonus) flow += flowRow('Премия (приходит с расчётом)', r.bonus, '', r.bonus / inc);
  if (evIn) flow += flowRow('Разовые поступления', evIn);
  if (S.settings.cashNow) flow += flowRow('Свободные деньги на начало месяца', +S.settings.cashNow);
  flow += flowRow('Постоянные расходы' + (S.fixed.length ? ' (' + S.fixed.map(f => esc(f.name).toLowerCase()).join(', ') + ')' : ''), -fixedSum, '', fixedSum / inc);
  flow += flowRow('Жизнь: еда, транспорт, остальное', -(+S.settings.living || 0), '', (+S.settings.living || 0) / inc);
  if (evOut) flow += flowRow('Разовые траты: ' + S.events.filter(e => e.month === cm && +e.amount < 0).map(e => esc(e.note || 'без названия').toLowerCase()).join(', '), -evOut, 'debt', evOut / inc);
  if (factTotal > 0) flow += flowRow('Уже оплачено по кредитам', -factTotal, 'debt', factTotal / inc);
  flow += flowRow(factTotal > 0 ? 'Осталось обязательных платежей' : 'Обязательные платежи', -r.minTotal, 'debt', r.minTotal / inc);
  flow += flowRow('Досрочное погашение', -r.extraTotal, 'extra', r.extraTotal / inc);
  flow += flowRow('Остаётся на счёте к концу месяца', r.cashEnd, 'total');
  let keep = [];
  const dlDebt = activeDebts().find(d => d.kind === 'deadline' && +d.balance > 0 && d.deadline && d.deadline > cm);
  if (r.reserved > 0.5) keep.push(`резерв на «${esc(dlDebt ? dlDebt.name : 'заём к сроку')}» ${fmt(r.reserved)}${dlDebt ? ` из ${fmt(dlDebt.balance)} к сроку` : ''}`);
  const buf = Math.min(+S.settings.buffer || 0, Math.max(0, r.cashEnd - r.reserved));
  if (buf > 0.5) keep.push(`подушка ${fmt(buf)}`);
  const flowNote = keep.length ? `<p class="sub" style="margin:10px 0 0">Это ${keep.join(', ')}. Держите их на отдельном накопительном счёте и не тратьте.</p>` : '';

  const ids = new Set([...Object.keys(r.pay).filter(k => r.pay[k] > 0.5), ...Object.keys(facts)]);
  const items = [...ids].map(id => {
    const d = debtById(id) || { name: debtName(id), dueDay: 28, color: '#888' };
    const remaining = r.pay[id] || 0, min = r.minPay[id] || 0, extra = r.extraPay[id] || 0, paid = facts[id] || 0;
    return { id, d, remaining, min, extra, paid };
  }).sort((a, b) => (+a.d.dueDay || 28) - (+b.d.dueDay || 28));
  const ym = ENG.parseM(cm);
  const list = items.map(it => {
    const done = it.remaining < 1 && it.paid > 0;
    const dd = Math.min(+it.d.dueDay || 28, new Date(ym.y, ym.m, 0).getDate());
    const parts = [];
    if (it.min > 0.5) parts.push(`${it.d.kind === 'deadline' ? 'возврат' : 'обязательный'} ${fmt(it.min)}`);
    if (it.extra > 0.5) parts.push(`<span class="x">досрочно ${fmt(it.extra)}</span>`);
    if (it.paid > 0) parts.push(`оплачено ${fmt(it.paid)}`);
    return `<div class="pay${done ? ' done' : ''}"><div class="day"><b>${dd}</b><span>${MS[ym.m - 1]}</span></div>
      <div><div class="pay-name"><span class="dot" style="background:${it.d.color}"></span>${esc(it.d.name)}</div><div class="pay-meta">${parts.join(' · ') || '—'}</div></div>
      <div class="pay-sum"><b>${done ? 'готово' : fmt(it.remaining)}</b>${done ? '' : `<button class="btn small" type="button" data-act="pay" data-id="${it.id}" data-amount="${Math.round(it.remaining)}" data-extra="${it.extra > 0.5 ? 1 : 0}">Отметить оплату</button>`}</div></div>`;
  }).join('');
  // next month peek
  const r1 = F.months[1];
  const peek = r1 ? `<div class="panel"><h3>Дальше: ${mName(r1.m)}</h3><p class="sub" style="margin:0">Обязательные ${fmt(r1.minTotal)}${r1.extraTotal > 0.5 ? `, досрочно ${fmt(r1.extraTotal)}` : ''}${r1.reserved > 0.5 ? `, в резерве к концу месяца ${fmt(r1.reserved)}` : ''}. Долг на конец месяца — ${fmtC(r1.totalBal)}.</p></div>` : '';
  el.innerHTML = `<div class="cols">
    <div><div class="panel"><h3>Деньги в ${mPrep(cm)}</h3><p class="sub">Как распределяется доход этого месяца по плану.</p><div class="flow">${flow}</div>${flowNote}</div>${peek}</div>
    <div class="panel"><h3>Платежи в ${mPrep(cm)}</h3><p class="sub">Отмечайте оплату — остаток долга и весь план пересчитаются.</p>${list || '<div class="empty">В этом месяце платежей нет.</div>'}
      <div class="row-actions" style="margin-top:12px"><button class="btn" type="button" data-act="pay">Внести другой платёж</button></div></div>
  </div>`;
}

// ---------- render: schedule (chart + table) ----------
function renderSchedule() {
  const el = $('#tab-schedule');
  if (loading || !activeDebts().length) { el.innerHTML = '<div class="panel empty">График появится после добавления кредитов.</div>'; return; }
  const cm = curMonth();
  const bl = S.baseline;
  const start = bl && bl.start < cm ? bl.start : cm;
  const fEnd = F.payoff || F.months[F.months.length - 1].m;
  const bEnd = bl && bl.rows.length ? bl.rows[bl.rows.length - 1].m : fEnd;
  const end = fEnd > bEnd ? fEnd : bEnd;
  const N = Math.min(ENG.diffM(start, end) + 1, 120);
  const W = Math.round(Math.max(560, Math.min(1120, (document.documentElement.clientWidth || 1000) - 72))), H = Math.round(W < 760 ? 340 : 380), pl = 64, pr = 16, pt = 16, pb = 32;
  const offF = ENG.diffM(start, cm);
  const ids = F.debts.filter(id => F.months.some(r => r.bal[id] > 0.5));
  const maxBal = Math.max(1, totalDebt() + Object.values(factsByMonth()[cm] || {}).reduce((a, v) => a + v, 0), ...(bl ? bl.rows.map(r => r.bal) : []), bl ? bl.startTotal : 0, ...S.history.map(h => h.t));
  const xs = (i) => pl + (W - pl - pr) * (N <= 1 ? 0 : i / (N - 1));
  const ys = (v) => pt + (H - pt - pb) * (1 - v / maxBal);
  // stacked areas (forecast). Start point at current balances.
  const layers = []; let lower = new Array(N).fill(0);
  const balAt = (id, i) => { const k = i - offF; if (k < 0) return null; if (k === 0) { const d = debtById(id); return d ? +d.balance : 0; } const r = F.months[k - 1]; return r ? r.bal[id] || 0 : 0; };
  for (const id of ids) {
    const top = lower.slice(); let pts = [];
    for (let i = offF; i < N; i++) { const b = balAt(id, i); if (b == null) continue; top[i] = lower[i] + b; }
    let d = '';
    for (let i = offF; i < N; i++) d += (i === offF ? 'M' : 'L') + xs(i).toFixed(1) + ',' + ys(top[i]).toFixed(1);
    for (let i = N - 1; i >= offF; i--) d += 'L' + xs(i).toFixed(1) + ',' + ys(lower[i]).toFixed(1);
    layers.push(`<path d="${d}Z" fill="${debtColor(id)}" fill-opacity=".78" stroke="none"/>`);
    lower = top;
  }
  // baseline line (balance at start of each month)
  let blLine = '';
  if (bl) {
    const o = ENG.diffM(start, bl.start); let d = `M${xs(o).toFixed(1)},${ys(bl.startTotal).toFixed(1)}`;
    bl.rows.forEach((r, k) => { const i = o + k + 1; if (i < N) d += `L${xs(i).toFixed(1)},${ys(r.bal).toFixed(1)}`; });
    blLine = `<path d="${d}" fill="none" stroke="var(--plan)" stroke-width="2.5" stroke-dasharray="7 5"/>`;
  }
  // history dots
  const dots = S.history.map(h => { const m = h.d.slice(0, 7); const day = +h.d.slice(8, 10); const i = ENG.diffM(start, m) + (day - 1) / 30; if (i < 0 || i > N - 1) return ''; return `<circle cx="${xs(i).toFixed(1)}" cy="${ys(h.t).toFixed(1)}" r="5" fill="var(--surface)" stroke="var(--fact)" stroke-width="2.5"/>`; }).join('');
  // grid
  let grid = '';
  for (let k = 0; k <= 4; k++) { const v = maxBal * k / 4; grid += `<line x1="${pl}" x2="${W - pr}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(--line)"/><text x="${pl - 8}" y="${ys(v) + 4}" text-anchor="end" font-size="12" fill="var(--ink-3)">${v >= 1e6 ? (v / 1e6).toFixed(1) + ' млн' : Math.round(v / 1e3) + ' т'}</text>`; }
  const step = N <= 13 ? 1 : N <= 26 ? 2 : N <= 40 ? 3 : 6;
  for (let i = 0; i < N; i += step) grid += `<text x="${xs(i)}" y="${H - 10}" text-anchor="middle" font-size="12" fill="var(--ink-3)">${mShort(ENG.addM(start, i))}</text>`;
  grid += `<line x1="${xs(offF)}" x2="${xs(offF)}" y1="${pt}" y2="${H - pb}" stroke="var(--ink)" stroke-opacity=".35"/>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" id="chartSvg" role="img" aria-label="Остаток долга по месяцам">${grid}${layers.join('')}${blLine}${dots}<line id="chartCursor" x1="0" x2="0" y1="${pt}" y2="${H - pb}" stroke="var(--ink)" stroke-width="1" visibility="hidden"/></svg>`;
  const legend = ids.map(id => `<span><span class="dot" style="background:${debtColor(id)}"></span>${esc(debtName(id))}</span>`).join('') + (bl ? `<span><svg width="26" height="10"><line x1="0" x2="26" y1="5" y2="5" stroke="var(--plan)" stroke-width="2.5" stroke-dasharray="6 4"/></svg> зафиксированный план</span>` : '') + `<span><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="none" stroke="var(--fact)" stroke-width="2"/></svg> фактический долг</span>`;
  // table
  const head = `<tr><th class="sticky">Месяц</th><th class="num">Доход</th><th class="num">Обязательные</th><th class="num">Досрочно</th><th class="num">В резерве</th><th class="num">Долг на конец</th>${ids.map(id => `<th class="num"><span class="dot" style="background:${debtColor(id)}"></span>${esc(debtName(id))}</th>`).join('')}</tr>`;
  const body = F.months.map((r, k) => `<tr class="${k === 0 ? 'cur' : ''}"><td class="sticky">${mName(r.m)}</td><td class="num">${fmtN(r.income)}</td><td class="num">${fmtN(r.minTotal)}</td><td class="num ${r.extraTotal > 0.5 ? 'pos' : 'muted'}">${r.extraTotal > 0.5 ? fmtN(r.extraTotal) : '—'}</td><td class="num muted">${r.reserved > 0.5 ? fmtN(r.reserved) : '—'}</td><td class="num"><b>${fmtN(r.totalBal)}</b></td>${ids.map(id => { const p = r.pay[id] || 0; const x = r.extraPay[id] || 0; return `<td class="num ${x > 0.5 ? 'pos' : p > 0.5 ? '' : 'muted'}">${p > 0.5 ? fmtN(p) : '—'}</td>`; }).join('')}</tr>`).join('');
  el.innerHTML = `<div class="panel"><h3>Как тают долги</h3><p class="sub">Цветные слои — прогноз остатка по каждому кредиту. Пунктир — план, зафиксированный ${bl ? dText(bl.createdAt.slice(0, 10)) : '(ещё не зафиксирован)'}. Кружки — фактический долг. Наведите или коснитесь графика, чтобы увидеть месяц.</p>
    <div class="chart">${svg}<div class="tip" id="chartTip"></div></div><div class="legend">${legend}</div></div>
    <div class="panel"><h3>График платежей</h3><p class="sub">Сколько и куда платить каждый месяц. Зелёным — досрочные суммы. Строка текущего месяца показывает то, что ещё осталось оплатить.</p><div class="tbl-wrap" style="max-height:70vh"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
  // tooltip
  const svgEl = $('#chartSvg'), tip = $('#chartTip'), cur = $('#chartCursor');
  const show = (ev) => {
    const rect = svgEl.getBoundingClientRect(); const x = (ev.clientX - rect.left) / rect.width * W;
    let i = Math.round((x - pl) / (W - pl - pr) * (N - 1)); i = Math.max(0, Math.min(N - 1, i));
    const m = ENG.addM(start, i); cur.setAttribute('x1', xs(i)); cur.setAttribute('x2', xs(i)); cur.setAttribute('visibility', 'visible');
    let lines = `<b>${mName(m)}</b>`;
    if (i >= offF) { let tot = 0; const per = ids.map(id => { const b = balAt(id, i) || 0; tot += b; return [id, b]; }).filter(x => x[1] > 0.5).sort((a, b) => b[1] - a[1]); lines += `<br>Прогноз: ${fmtC(tot)}`; per.slice(0, 5).forEach(([id, b]) => lines += `<br><span class="dot" style="background:${debtColor(id)}"></span>${esc(debtName(id))}: ${fmtC(b)}`); }
    if (bl) { const k = ENG.diffM(bl.start, m); const v = k === 0 ? bl.startTotal : (bl.rows[k - 1] || {}).bal; if (v != null) lines += `<br>План: ${fmtC(v)}`; }
    tip.innerHTML = lines; tip.style.display = 'block';
    const px = xs(i) / W * rect.width; tip.style.left = Math.max(100, Math.min(rect.width - 100, px)) + 'px'; tip.style.top = (ys(maxBal * 0.9) / H * rect.height) + 'px';
  };
  svgEl.addEventListener('pointermove', show); svgEl.addEventListener('pointerdown', show);
  svgEl.addEventListener('pointerleave', () => { tip.style.display = 'none'; cur.setAttribute('visibility', 'hidden'); });
}

// ---------- render: plan / fact ----------
let pfOpen = null;
function renderPF() {
  const el = $('#tab-pf');
  if (loading) { el.innerHTML = ''; return; }
  const bl = S.baseline; const cm = curMonth(); const fbm = factsByMonth();
  const fixBtn = `<button class="btn primary" type="button" data-act="fix-plan">${bl ? 'Зафиксировать текущий прогноз как новый план' : 'Зафиксировать план'}</button>`;
  if (!bl) { el.innerHTML = `<div class="panel empty">План ещё не зафиксирован. Зафиксируйте его, чтобы сравнивать с фактическими платежами.<div style="margin-top:12px">${activeDebts().length ? fixBtn : ''}</div></div>${renderPaymentsLog()}`; return; }
  const past = bl.rows.filter(r => r.m <= cm);
  const today = +todayISO().slice(8, 10);
  const dueSoFar = (r) => r.m < cm ? r.payTotal : Object.entries(r.pay).reduce((a, [k, v]) => { const d = debtById(k); return a + ((d ? +d.dueDay || 28 : 28) <= today ? v : 0); }, 0);
  const planSum = past.reduce((a, r) => a + dueSoFar(r), 0);
  const factSum = past.reduce((a, r) => a + Object.values(fbm[r.m] || {}).reduce((x, v) => x + v, 0), 0);
  const prevRow = bl.rows.find(r => r.m === ENG.addM(cm, -1));
  const planBalNow = prevRow ? prevRow.bal : bl.startTotal;
  const diff = factSum - planSum;
  const rows = bl.rows.slice(0, Math.max(past.length + 3, 6)).map(r => {
    const f = fbm[r.m] || {}; const ft = Object.values(f).reduce((a, v) => a + v, 0);
    const isFuture = r.m > cm; const d = ft - r.payTotal;
    const status = isFuture ? '<span class="muted">впереди</span>' : r.m === cm ? (ft >= r.payTotal - 1 ? '<span class="pos">выполнено</span>' : '<span class="muted">в процессе</span>') : (ft >= r.payTotal - 1 ? '<span class="pos">выполнено</span>' : '<span class="neg">недоплата</span>');
    let html = `<tr class="click ${r.m === cm ? 'cur' : ''}" data-act="pf-row" data-m="${r.m}"><td class="sticky">${mName(r.m)}</td><td class="num">${fmtN(r.payTotal)}</td><td class="num">${isFuture ? '—' : fmtN(ft)}</td><td class="num ${isFuture ? 'muted' : d >= 0 ? 'pos' : 'neg'}">${isFuture ? '—' : (d >= 0 ? '+' : '−') + fmtN(Math.abs(d))}</td><td class="num">${fmtN(r.bal)}</td><td>${status}</td></tr>`;
    if (pfOpen === r.m) {
      const keys = new Set([...Object.keys(r.pay), ...Object.keys(f)]);
      html += [...keys].map(k => `<tr class="detail"><td class="sticky"><span class="dot" style="background:${debtColor(k)}"></span>${esc(debtName(k))}</td><td class="num">${fmtN(r.pay[k] || 0)}</td><td class="num">${isFuture ? '—' : fmtN(f[k] || 0)}</td><td class="num">${isFuture ? '' : (((f[k] || 0) - (r.pay[k] || 0)) >= 0 ? '+' : '−') + fmtN(Math.abs((f[k] || 0) - (r.pay[k] || 0)))}</td><td></td><td></td></tr>`).join('');
    }
    return html;
  }).join('');
  el.innerHTML = `<div class="panel"><h3>Выполнение плана</h3><p class="sub">План зафиксирован ${dText(bl.createdAt.slice(0, 10))}, стратегия «${STRATS[bl.strategy] ? STRATS[bl.strategy].name : bl.strategy}», финиш по плану — ${bl.payoff ? mName(bl.payoff) : 'не определён'}.</p>
    <div class="stats" style="margin:0 0 14px"><div class="stat"><b>${fmtC(planSum)}</b><span>по плану к оплате на сегодня</span></div><div class="stat"><b>${fmtC(factSum)}</b><span>оплачено фактически</span></div><div class="stat"><b class="${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : '−'}${fmtC(Math.abs(diff))}</b><span>${diff >= 0 ? 'опережение' : 'отставание'}</span></div><div class="stat"><b>${fmtC(totalDebt())}</b><span>долг сейчас, по плану ${fmtC(planBalNow)} на начало месяца</span></div></div>
    <div class="tbl-wrap"><table><thead><tr><th class="sticky">Месяц</th><th class="num">План</th><th class="num">Факт</th><th class="num">Разница</th><th class="num">Долг по плану на конец</th><th>Статус</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="sub" style="margin:10px 0 0">Нажмите на месяц, чтобы увидеть разбивку по кредитам.</p>
    <div class="row-actions" style="margin-top:8px">${fixBtn}</div></div>${renderPaymentsLog()}`;
}
function renderPaymentsLog() {
  const ps = S.payments.slice().sort((a, b) => a.date < b.date ? 1 : -1);
  if (!ps.length) return `<div class="panel"><h3>Внесённые платежи</h3><p class="sub" style="margin:0">Пока пусто. Отмечайте оплату на вкладке «Этот месяц» или кнопкой «Внести платёж» у кредита.</p></div>`;
  return `<div class="panel"><h3>Внесённые платежи</h3><div class="tbl-wrap"><table><thead><tr><th>Дата</th><th>Кредит</th><th class="num">Сумма</th><th class="num">В тело долга</th><th class="num">Проценты</th><th></th></tr></thead><tbody>${ps.map(p => `<tr><td>${dText(p.date)}${p.extra ? ' <span class="tag target">досрочно</span>' : ''}</td><td><span class="dot" style="background:${debtColor(p.debtId)}"></span>${esc(debtName(p.debtId))}${p.note ? `<div class="muted" style="font-size:12px">${esc(p.note)}</div>` : ''}</td><td class="num">${fmtN(p.amount)}</td><td class="num">${fmtN(p.principal)}</td><td class="num muted">${fmtN((+p.amount || 0) - (+p.principal || 0))}</td><td class="num"><button class="btn small ghost danger" type="button" data-act="del-pay" data-id="${p.id}">Удалить</button></td></tr>`).join('')}</tbody></table></div><p class="sub" style="margin:10px 0 0">Удаление платежа возвращает его сумму «в тело долга» обратно в остаток кредита.</p></div>`;
}

// ---------- render: debts ----------
function payRule(d) {
  if (d.kind === 'card') return `мин. ${fmtN0(d.minPct)}% долга${d.plusInterest ? ' + проценты' : ''}`;
  if (d.kind === 'deadline') return d.deadline ? `вернуть до конца: ${mName(d.deadline)}` : 'срок не задан';
  return `${fmt(d.payment)} в месяц`;
}
function renderDebts() {
  const el = $('#tab-debts');
  if (loading) { el.innerHTML = ''; return; }
  const act = activeDebts(); const closed = S.debts.filter(d => d.status === 'closed');
  let target = null, targetNow = false;
  if (F && F.months[0]) { const ex = Object.entries(F.months[0].extraPay).sort((a, b) => b[1] - a[1]); if (ex.length) { target = ex[0][0]; targetNow = true; } }
  if (!target && F) { const r = F.months.find(r => r.extraTotal > 0.5); if (r) target = Object.keys(r.extraPay)[0]; }
  const item = (d) => `<div class="debt"><div>
      <h4><span class="dot" style="background:${d.color}"></span>${esc(d.name)}</h4>
      <div class="facts"><span>Остаток <b>${fmt(d.balance)}</b>${d.balanceDate ? ` на ${dText(d.balanceDate)}` : ''}</span><span>Ставка <b>${fmtN0(d.rate || 0)}%</b></span><span>${payRule(d)}</span><span>Срок ${d.dueDay || '—'}-го${d.payDay && +d.payDay !== +d.dueDay ? `, плачу ${d.payDay}-го` : ''}</span>${F && F.payoffBy[d.id] ? `<span>Закроется: <b>${mName(F.payoffBy[d.id])}</b></span>` : ''}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><span class="tag">${KIND[d.kind] || d.kind}</span>${(+d.rate || 0) >= 50 ? '<span class="tag hot">дорогой долг</span>' : ''}${target === d.id ? `<span class="tag target">${targetNow ? 'сейчас гасим досрочно' : 'первая цель досрочки'}</span>` : ''}</div>
      ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}</div>
      <div class="row-actions" style="align-content:start"><button class="btn small primary" type="button" data-act="pay" data-id="${d.id}">Внести платёж</button><button class="btn small" type="button" data-act="edit-debt" data-id="${d.id}">Изменить</button><button class="btn small ghost" type="button" data-act="close-debt" data-id="${d.id}">Закрыть</button></div></div>`;
  el.innerHTML = `<div class="panel"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><div><h3>Действующие кредиты</h3><p class="sub" style="margin:0">Раз в месяц сверяйте остатки с приложениями банков.</p></div><button class="btn primary" type="button" data-act="add-debt">Добавить кредит</button></div>
    ${act.length ? act.map(item).join('') : '<div class="empty">Действующих кредитов нет.</div>'}</div>
    ${closed.length ? `<div class="panel"><h3>Закрытые</h3>${closed.map(d => `<div class="debt"><div><h4 class="muted"><span class="dot" style="background:${d.color}"></span>${esc(d.name)}</h4><div class="facts"><span>Закрыт ${d.closedAt ? dText(d.closedAt) : ''}</span></div></div><div class="row-actions"><button class="btn small" type="button" data-act="reopen-debt" data-id="${d.id}">Вернуть в работу</button><button class="btn small ghost danger" type="button" data-act="del-debt" data-id="${d.id}">Удалить</button></div></div>`).join('')}</div>` : ''}`;
}

function debtDialog(d) {
  const isNew = !d; d = d || { name: '', kind: 'annuity', balance: '', balanceDate: todayISO(), rate: '', payment: '', minPct: 5, plusInterest: false, minFloor: 0, dueDay: 15, deadline: ENG.addM(curMonth(), 3), note: '' };
  const html = `<h3>${isNew ? 'Новый кредит' : 'Изменить кредит'}</h3>
    ${field('Название', inText('name', d.name, 'required placeholder="Например, Сбер · кредит"'))}
    ${field('Тип', `<select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}
    <div class="form">
      ${field('Остаток долга, ₽', inNum('balance', d.balance, 'required'))}
      ${field('Остаток на дату', `<input type="date" name="balanceDate" value="${esc(d.balanceDate || todayISO())}">`)}
      ${field('Ставка, % годовых', inNum('rate', d.rate))}
      ${field('Срок платежа, число', `<input type="number" name="dueDay" min="1" max="31" value="${esc(d.dueDay || 15)}">`)}
      ${field('Когда я плачу, число', `<input type="number" name="payDay" min="1" max="31" value="${esc(d.payDay || '')}" placeholder="как срок">`, 'Для календаря: например, платить из зарплаты 15-го, хотя срок 25-го.')}
      <div class="field k-annuity k-fixed"><label>Платёж в месяц, ₽</label>${inNum('payment', d.payment)}</div>
      <div class="field k-card"><label>Мин. платёж, % от долга</label>${inNum('minPct', d.minPct)}</div>
      <div class="field k-card"><label>Мин. платёж не меньше, ₽</label>${inNum('minFloor', d.minFloor)}</div>
      <div class="field k-card"><label class="check" style="min-height:auto"><input type="checkbox" name="plusInterest" ${d.plusInterest ? 'checked' : ''}> плюс начисленные проценты</label></div>
      <div class="field k-deadline"><label>Вернуть до (месяц)</label><input type="month" name="deadline" value="${esc(d.deadline || '')}"></div>
    </div>
    ${field('Заметка', `<input type="text" name="note" value="${esc(d.note || '')}">`)}`;
  const foot = `<button class="btn ghost" value="cancel" formnovalidate>Отмена</button><button class="btn primary" value="save">${isNew ? 'Добавить' : 'Сохранить'}</button>`;
  openDialog(html, foot, (v, b) => {
    const g = (n) => b.querySelector(`[name="${n}"]`);
    const name = g('name').value.trim(); if (!name) { g('name').focus(); return false; }
    const obj = isNew ? { id: uid(), color: PAL[S.debts.length % PAL.length], status: 'active' } : d;
    Object.assign(obj, { name, kind: g('kind').value, balance: parseNum(g('balance').value), balanceDate: g('balanceDate').value || todayISO(), rate: parseNum(g('rate').value), dueDay: Math.min(31, Math.max(1, parseInt(g('dueDay').value) || 15)), payDay: parseInt(g('payDay').value) ? Math.min(31, Math.max(1, parseInt(g('payDay').value))) : null, payment: parseNum(g('payment').value), minPct: parseNum(g('minPct').value), minFloor: parseNum(g('minFloor').value), plusInterest: g('plusInterest').checked, deadline: g('deadline').value || null, note: g('note').value.trim() });
    if (isNew) S.debts.push(obj);
    recordHistory(); persistNow(); renderAll(); toast(isNew ? 'Кредит добавлен' : 'Изменения сохранены');
  }, (b) => {
    const sync = () => { const k = b.querySelector('[name=kind]').value; $$('.k-annuity,.k-fixed,.k-card,.k-deadline', b).forEach(e => e.hidden = !e.classList.contains('k-' + k)); };
    b.querySelector('[name=kind]').addEventListener('change', sync); sync();
  });
}

function payDialog(id, amount, isExtra, date) {
  const act = activeDebts(); if (!act.length) return;
  id = id || act[0].id;
  const html = `<h3>Внести платёж</h3>
    ${field('Кредит', `<select name="debt">${act.map(d => `<option value="${d.id}" ${d.id === id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`)}
    <div class="form">${field('Дата', `<input type="date" name="date" value="${date || todayISO()}">`)}${field('Сумма, ₽', inNum('amount', amount || '', 'required'))}</div>
    <label class="check"><input type="checkbox" name="extra" ${isExtra ? 'checked' : ''}> Досрочное погашение</label>
    <div class="form">${field('Из них в тело долга, ₽', inNum('principal', ''), 'Оценка: сумма минус проценты, набежавшие с даты последнего остатка. Поправьте по данным банка, если знаете точно.')}${field('Комментарий', '<input type="text" name="note">')}</div>
    <p class="sub" id="payHint" style="margin:0"></p>`;
  openDialog(html, `<button class="btn ghost" value="cancel" formnovalidate>Отмена</button><button class="btn primary" value="save">Сохранить платёж</button>`, (v, b) => {
    const g = (n) => b.querySelector(`[name="${n}"]`);
    const d = debtById(g('debt').value); const amt = parseNum(g('amount').value);
    if (!d || amt <= 0) { g('amount').focus(); return false; }
    let principal = g('principal').value.trim() === '' ? estPrincipal(d, amt, g('date').value) : parseNum(g('principal').value);
    principal = Math.max(0, Math.min(principal, +d.balance || 0));
    const before = +d.balance || 0;
    S.payments.push({ id: uid(), debtId: d.id, date: g('date').value || todayISO(), amount: amt, principal: Math.round(principal * 100) / 100, extra: g('extra').checked, note: g('note').value.trim() });
    d.balance = Math.max(0, Math.round((before - principal) * 100) / 100);
    d.balanceDate = g('date').value || todayISO();
    if (g('extra').checked && d.kind === 'annuity' && S.settings.prepayMode === 'payment' && before > 0 && d.balance > 0) {
      d.payment = Math.round((+d.payment || 0) * d.balance / before * 100) / 100;
    }
    let msg = 'Платёж сохранён, план пересчитан';
    if (d.balance <= 0.5) { d.status = 'closed'; d.closedAt = d.balanceDate; d.balance = 0; msg = `«${d.name}» погашен и перенесён в закрытые`; }
    recordHistory(); persistNow(); renderAll(); toast(msg);
  }, (b) => {
    const g = (n) => b.querySelector(`[name="${n}"]`);
    const upd = () => { const d = debtById(g('debt').value); const amt = parseNum(g('amount').value); const p = estPrincipal(d, amt, g('date').value); g('principal').placeholder = amt ? fmtN0(Math.round(p)) : ''; $('#payHint').textContent = d ? `Остаток сейчас ${fmt(d.balance)} на ${dText(d.balanceDate)}. После платежа ≈ ${fmt(Math.max(0, d.balance - (g('principal').value.trim() ? parseNum(g('principal').value) : p)))}.${d.kind === 'annuity' && S.settings.prepayMode === 'payment' ? ' При досрочном погашении ежемесячный платёж пересчитается пропорционально — сверьте его с банком.' : ''}` : ''; };
    ['debt', 'amount', 'date', 'principal'].forEach(n => g(n).addEventListener('input', upd)); upd();
  });
}
function estPrincipal(d, amt, date) {
  if (!d || !amt) return 0;
  const days = Math.max(0, (new Date(date || todayISO()) - new Date(d.balanceDate || todayISO())) / 864e5);
  const interest = (+d.balance || 0) * (+d.rate || 0) / 100 / 365 * days;
  return Math.max(0, Math.min(+d.balance || 0, amt - interest));
}

// ---------- render: strategy ----------
let whatIf = 0;
function renderStrategy() {
  const el = $('#tab-strategy');
  if (loading) { el.innerHTML = ''; return; }
  if (!activeDebts().length) { el.innerHTML = '<div class="panel empty">Стратегия появится после добавления кредитов.</div>'; return; }
  const s = S.settings;
  const runs = ['avalanche', 'hybrid', 'snowball'].map(k => ({ k, r: ENG.simulate(S, simOpts({ strategy: k })) }));
  const minOnly = ENG.simulate(S, simOpts({ extra: false, horizon: 360 }));
  const best = Math.min(...runs.map(x => x.r.totalInterest));
  const tr = (name, r, cur) => `<tr class="${cur ? 'cur' : ''}"><td>${name}</td><td>${r.payoff ? mName(r.payoff) : 'более 30 лет'}</td><td class="num">${fmtC(r.totalInterest)}</td><td class="num">${r.totalInterest - best > 1000 ? '+' + fmtC(r.totalInterest - best) : '—'}</td></tr>`;
  const ord = ENG.order(activeDebts().filter(d => +d.balance > 0).map(d => ({ ...d, _bal: +d.balance })), s.strategy, +s.hybridThreshold || 100000, s.manualOrder || []).filter(d => d.kind !== 'deadline' && (+d.rate || 0) > 0);
  const manualList = s.strategy === 'manual' ? `<div class="order" style="margin-top:12px">${ord.map((d, i) => `<div class="order-item"><b>${i + 1}</b><span><span class="dot" style="background:${d.color}"></span>${esc(d.name)} <span class="muted">${fmtN0(d.rate)}%</span></span><span class="row-actions"><button class="btn small" type="button" data-act="ord-up" data-id="${d.id}" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button><button class="btn small" type="button" data-act="ord-down" data-id="${d.id}" ${i === ord.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button></span></div>`).join('')}</div>` : '';
  const dl = activeDebts().filter(d => d.kind === 'deadline' && +d.balance > 0);
  const miss = F.deadlineMiss[0];
  const queue = ord.map(d => `«${esc(d.name)}» (${fmtN0(d.rate)}%${F.payoffBy[d.id] ? ', закроется в ' + mPrep(F.payoffBy[d.id]) : ''})`).join(' → ');
  const zero = activeDebts().filter(d => (+d.rate || 0) === 0 && d.kind !== 'deadline');
  el.innerHTML = `<div class="panel"><h3>Как гасим</h3><p class="sub">Выберите правило, по которому свободные деньги идут на досрочное погашение.</p>
    <div class="strats">${Object.entries(STRATS).map(([k, v]) => `<button type="button" class="strat" data-act="strategy" data-k="${k}" aria-pressed="${s.strategy === k}"><b>${v.name}${k === 'avalanche' ? ' · рекомендую' : ''}</b><span>${v.text}</span></button>`).join('')}</div>
    ${s.strategy === 'hybrid' ? `<div class="form" style="margin-top:12px">${field('Порог «мелкого» долга, ₽', `<input type="text" inputmode="decimal" data-set="hybridThreshold" value="${esc(fmtN0(s.hybridThreshold))}">`)}</div>` : ''}${manualList}</div>
    <div class="panel"><h3>Сравнение</h3><p class="sub">Тот же бюджет, разные правила. Проценты — сколько уйдёт банкам от сегодняшнего дня.</p>
    <div class="tbl-wrap"><table><thead><tr><th>Вариант</th><th>Без долгов</th><th class="num">Проценты</th><th class="num">Дороже лучшего</th></tr></thead><tbody>${runs.map(x => tr(STRATS[x.k].name, x.r, x.k === s.strategy)).join('')}${tr('Только минимальные платежи', minOnly, false)}</tbody></table></div>
    <h3 style="margin-top:18px">Что, если сократить расходы</h3><p class="sub">Двигайте ползунок — сами настройки не меняются.</p>
    <input type="range" min="0" max="100000" step="5000" value="${whatIf}" id="whatIf" aria-label="Сократить расходы на">
    <div id="whatIfOut" class="sub" style="margin:4px 0 0"></div></div>
    <div class="panel"><h3>Стратегия по шагам</h3><p class="sub">Логика плана, на которой построены расчёты.</p>
    <ol class="phases">
      <li><div><h4>Остановить рост долга — с сегодняшнего дня</h4><p>С 8 июля долг по карте Альфа-Банка вырос с нуля до 762 тыс. ₽, за сентябрь долг по карте Т-Банка — почти вдвое, с 400 до 760 тыс., плюс новый кредит Яндекса на 142 тыс. Любая новая трата по карте под 60% отодвигает финиш. Карты — не пользоваться (лучше убрать из Apple Pay и кошелька), живём на дебетовой карте в пределах суммы «прочие расходы». Новых заявок на кредиты не подавать: отказы сейчас главный фактор, который тянет рейтинг вниз.</p></div></li>
      ${dl.length ? `<li><div><h4>До ${MG[ENG.parseM(dl[0].deadline).m - 1]} ${ENG.parseM(dl[0].deadline).y}: только обязательные платежи и резерв</h4><p>Частный заём без процентов, но с жёстким сроком. Поэтому всё, что остаётся после обязательных платежей, откладываем на него, а досрочно банкам пока не платим. Резерв считается по зарплате без премий, чтобы срок не зависел от них. ${miss ? `При текущих цифрах к сроку не хватает около <b>${fmt(miss.amount)}</b> — лучше договориться о переносе этой части уже сейчас, а не в декабре. Если перенести нельзя, крайний вариант — взять недостающее с кредитной карты на 1–2 месяца: это обойдётся примерно в 5–8% от суммы, но сохранит договорённость.` : 'По расчёту денег к сроку хватает.'}</p></div></li>` : ''}
      <li><div><h4>Дальше — лавина по ставке</h4><p>Все свободные деньги и каждая премия целиком идут в самый дорогой долг, остальные — по минимуму. Очередь: ${queue || '—'}. Каждый закрытый кредит освобождает его платёж, и он добавляется к следующему — сумма досрочки растёт сама.</p></div></li>
      <li><div><h4>Закрывать погашенные карты</h4><p>Пока карта открыта, банки считают её лимит в вашей долговой нагрузке, даже при нулевом долге. После погашения карту лучше закрыть совсем, а не держать «на всякий случай»: в июле карта Альфа-Банка была погашена полностью — судя по датам, за счёт кредитной линии Т-Банка, которая в те же дни выросла почти на миллион, — а к концу сентября снова выбрана. Перекладывание долга с карты на кредит работает, только если карта после этого закрыта.</p></div></li>
    </ol>
    <h3 style="margin-top:18px">Правила</h3>
    <ul class="rules">
      <li>Автоплатёж на дату за 2–3 дня до срока. В истории есть просрочки на 1 день по карте Альфа-Банка — это ровно такой случай.</li>
      <li>Досрочное погашение кредита оформляйте в приложении банка до даты списания; режим — «уменьшить платёж» (меньше обязательная нагрузка, а освободившиеся деньги всё равно идут в долг).</li>
      <li>По карте досрочка — это просто платёж сверх минимального, отдельно ничего оформлять не нужно.</li>
      ${zero.length ? `<li>Беспроцентные рассрочки (${zero.map(d => esc(d.name)).join(', ')}) гасим строго по графику — досрочно платить невыгодно.</li>` : ''}
      <li>Раз в месяц сверяйте остатки с приложениями банков и отмечайте платежи — план пересчитается от реальных цифр.</li>
    </ul>
    <h3 style="margin-top:18px">Что ещё может ускорить</h3>
    <ul class="rules">
      <li>Налоговый вычет за квартиру, купленную в апреле 2024 в ипотеку: если вы собственник и вычет раньше не получали, можно вернуть до 260 тыс. ₽ за покупку и до 390 тыс. с процентов по ипотеке. Добавьте его разовым поступлением на вкладке «Бюджет», когда подадите декларацию.</li>
      <li>Исправить кредитную историю: три рассрочки Совкомбанка с нулевым долгом всё ещё числятся действующими и завышают число открытых обязательств.</li>
      <li>Проверить запись Альфа-Банка от 30.09.2026 о возможном мошенничестве по заявке на 1,4 млн ₽. Если вы её не подавали — сразу звоните в банк.</li>
      <li>Рефинансирование карт под меньшую ставку имеет смысл пробовать одной точечной заявкой после закрытия первой карты, когда нагрузка снизится. Массовые заявки сейчас только навредят.</li>
    </ul></div>`;
  const upd = () => {
    const v = +$('#whatIf').value; whatIf = v;
    if (!v) { $('#whatIfOut').innerHTML = 'Сдвиньте ползунок, чтобы увидеть эффект.'; return; }
    const T = clone(S); T.settings.living = Math.max(0, (+T.settings.living || 0) - v);
    const r = ENG.simulate(T, simOpts());
    const months = F.payoff && r.payoff ? ENG.diffM(r.payoff, F.payoff) : 0;
    $('#whatIfOut').innerHTML = `Минус ${fmt(v)} в месяц → без долгов к <b>${r.payoff ? mDat(r.payoff) : '—'}</b>${months > 0 ? ` (на ${months} ${plural(months, ['месяц', 'месяца', 'месяцев'])} раньше)` : ''}, проценты меньше на <b>${fmtC(F.totalInterest - r.totalInterest)}</b>.${r.deadlineMiss[0] ? ` Нехватка к сроку частного займа: ${fmt(r.deadlineMiss[0].amount)}.` : (F.deadlineMiss[0] ? ' К сроку частного займа денег хватает.' : '')}`;
  };
  $('#whatIf').addEventListener('input', upd); upd();
}



// ---------- lazy vendor scripts ----------
const loaded = {};
function loadScript(src) { if (!loaded[src]) loaded[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Не удалось загрузить ' + src)); document.head.appendChild(s); }); return loaded[src]; }
async function pdfLib() { await loadScript('vendor/pdf.min.js'); window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; return window.pdfjsLib; }
const readBuf = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
function pickFiles(accept, multiple) { return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = !!multiple; i.onchange = () => res(Array.from(i.files || [])); i.click(); }); }

// ---------- render: calendar ----------
let calK = 0;
function calendarFor(k) {
  const cm = ENG.addM(curMonth(), k); const r = F.months[k]; if (!r) return null;
  const sm = S.salary; const sched = ENG.incomeSchedule(S, curMonth(), k + 2).rows[k];
  const n = dim(cm); const items = [];
  const clamp = (d) => Math.min(Math.max(1, +d || 1), n);
  const prevName = MN[ENG.parseM(ENG.addM(cm, -1)).m - 1];
  if (sched.finPrev > 0.5) items.push({ day: clamp(sm.salDay || 10), kind: 'in', name: `Расчёт за ${prevName}${sched.bonus > 0.5 && S.settings.bonusesInPlan ? `, включая премию ≈ ${fmtC(sched.bonus)}` : ''}`, amt: S.settings.bonusesInPlan ? sched.finPrev : sched.finPrev - sched.bonus });
  if (sched.adv > 0.5) items.push({ day: clamp(sm.advDay || 25), kind: 'in', name: `Аванс за ${MN[ENG.parseM(cm).m - 1]}`, amt: sched.adv });
  for (const f of S.fixed) items.push({ day: clamp(f.day), kind: 'out', name: f.name, amt: +f.amount || 0 });
  for (const e of S.events.filter(e => e.month === cm)) items.push({ day: clamp(e.day || 1), kind: +e.amount >= 0 ? 'in' : 'out', name: e.note || 'Разовое', amt: Math.abs(+e.amount || 0) });
  const facts = k === 0 ? (factsByMonth()[cm] || {}) : {};
  for (const p of k === 0 ? S.payments.filter(p => p.date.slice(0, 7) === cm) : []) items.push({ day: +p.date.slice(8, 10), kind: 'paid', name: debtName(p.debtId), amt: +p.amount, debt: p.debtId });
  for (const id of Object.keys(r.pay)) {
    const d = debtById(id); if (!d) continue;
    const min = r.minPay[id] || 0, ex = r.extraPay[id] || 0;
    const day = clamp(d.payDay || d.dueDay || 28);
    if (min > 0.5) items.push({ day, kind: 'debt', name: d.name, amt: min, debt: id, due: d.dueDay, early: d.payDay && +d.payDay !== +d.dueDay });
    if (ex > 0.5) items.push({ day: Math.max(day, clamp((sm.salDay || 10) + 1)), kind: 'extra', name: d.name + ' — досрочно', amt: ex, debt: id });
  }
  const order = { in: 0, paid: 1, debt: 2, out: 3, extra: 4 };
  items.sort((a, b) => a.day - b.day || order[a.kind] - order[b.kind]);
  const start = k === 0 ? (+S.settings.cashNow || 0) : F.months[k - 1].cashEnd;
  const living = (+S.settings.living || 0) / n;
  let bal = start, minBal = Infinity, minDay = 1; const byDay = [];
  for (let d = 1; d <= n; d++) {
    const its = items.filter(i => i.day === d);
    for (const i of its) { if (i.kind === 'in') bal += i.amt; else bal -= i.amt; i.after = bal; }
    bal -= living;
    if (bal < minBal) { minBal = bal; minDay = d; }
    byDay.push({ d, its, bal });
  }
  return { cm, items, byDay, start, living, minBal, minDay, reserved: r.reserved || 0, n };
}
function payWindows() {
  // which payments fall into the "advance" half (from advance day to the next salary day)
  const sm = S.salary, ad = +sm.advDay || 25, sd = +sm.salDay || 10;
  const heavy = [];
  let advSum = 0, salSum = 0;
  for (const d of activeDebts()) {
    const r0 = F.months[0]; const amt = (r0 && r0.minPay[d.id]) || 0; if (amt < 1 || d.kind === 'deadline') continue;
    const day = +(d.payDay || d.dueDay || 28);
    const inAdv = day >= ad - 1 || day < sd;
    if (inAdv) { advSum += amt; heavy.push({ d, amt, day }); } else salSum += amt;
  }
  return { advSum, salSum, heavy: heavy.sort((a, b) => b.amt - a.amt) };
}
function renderCalendar() {
  const el = $('#tab-calendar');
  if (!activeDebts().length) { el.innerHTML = '<div class="panel empty">Календарь появится после добавления кредитов.</div>'; return; }
  const c = calendarFor(calK); if (!c) { el.innerHTML = ''; return; }
  const sm = S.salary;
  const chips = [0, 1, 2].map(k => `<button type="button" class="chip" data-act="cal-k" data-k="${k}" aria-pressed="${k === calK}">${MN[ENG.parseM(ENG.addM(curMonth(), k)).m - 1]}</button>`).join('');
  const w = payWindows(); const sched = ENG.incomeSchedule(S, curMonth(), 1).rows[0];
  let rec = '';
  if (w.heavy.length && w.advSum > 0.6 * (sched.adv || 1)) {
    rec = `<div class="alert warn" style="margin-bottom:12px"><b>Аванс перегружен.</b> Из аванса (${sm.advDay}-го) уходит ${fmt(w.advSum)} платежей, из зарплаты (${sm.salDay}-го) — ${fmt(w.salSum)}. Платежи ниже лучше вносить из зарплаты, около ${(+sm.salDay || 10) + 5}-го: банку всё равно, если деньги придут раньше срока.
      <div style="display:grid;gap:6px;margin-top:8px">${w.heavy.slice(0, 4).map(h => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><span>${esc(h.d.name)}: ${fmt(h.amt)}, срок ${h.d.dueDay}-го${+h.d.dueDay === +sm.advDay ? ' — <b>в один день с авансом</b>' : ''}</span><button class="btn small" type="button" data-act="set-payday" data-id="${h.d.id}" data-day="${(+sm.salDay || 10) + 5}">Платить ${(+sm.salDay || 10) + 5}-го</button></div>`).join('')}</div></div>`;
  }
  const rows = c.byDay.filter(x => x.its.length).map(x => {
    const dt = new Date(ENG.parseM(c.cm).y, ENG.parseM(c.cm).m - 1, x.d);
    return `<div class="cal-day${x.bal < 0 ? ' neg-day' : ''}"><div class="day"><b>${x.d}</b><span>${WD[dt.getDay()]}</span></div><div class="cal-items">${x.its.map(i => {
      const cls = i.kind === 'in' ? 'pos' : i.kind === 'paid' ? 'muted' : '';
      const sign = i.kind === 'in' ? '+' : i.kind === 'paid' ? '✓ ' : '−';
      const note = i.kind === 'debt' && i.early ? ` <span class="muted">(срок ${i.due}-го)</span>` : i.kind === 'paid' ? ' <span class="muted">оплачено</span>' : '';
      return `<div class="cal-item"><span>${i.debt ? `<span class="dot" style="background:${debtColor(i.debt)}"></span>` : ''}${esc(i.name)}${note}</span><span class="num ${cls}">${sign}${fmtN(i.amt)}</span></div>`;
    }).join('')}</div><div class="cal-bal num ${x.bal < 0 ? 'neg' : x.bal < 20000 ? 'warnc' : ''}">${fmtN(x.bal)}</div></div>`;
  }).join('');
  const warn = c.minBal < 0 ? `<div class="alert danger" style="margin-bottom:12px"><b>${c.minDay} ${MG[ENG.parseM(c.cm).m - 1]} на счёте не хватит около ${fmt(-c.minBal)}.</b> Перенесите платёж на день после зарплаты или отложите деньги заранее.</div>` : '';
  el.innerHTML = `<div class="panel"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><div><h3>Календарь: ${mName(c.cm)}</h3><p class="sub" style="margin:0">Когда приходят деньги и когда списания. Справа — остаток на счёте после дня с учётом ежедневных трат ≈ ${fmt(c.living)} в день.</p></div><div class="chips">${chips}</div></div>
    <div style="margin-top:14px">${warn}${calK === 0 ? rec : ''}</div>
    <div class="cal-head"><span>На начало месяца</span><b class="num">${fmtN(c.start)}</b></div>
    <div class="cal">${rows}</div>
    ${c.reserved > 0.5 ? `<p class="sub" style="margin:12px 0 0">Из остатка на конец месяца ${fmt(c.reserved)} — резерв на частный заём, его не тратим.</p>` : ''}
    <p class="sub small" style="margin:8px 0 0">Даты зарплаты и аванса, дни постоянных расходов и «когда я плачу» по кредитам меняются на вкладках «Бюджет» и «Кредиты».</p></div>`;
}

// ---------- render: budget ----------
function salaryPreview() {
  const acc = ENG.accrualSeries(S, curMonth(), ENG.addM(curMonth(), 12));
  const regs = Object.values(acc).filter(a => !a.fact);
  const reg = regs.length ? regs.reduce((a, r) => a + r.reg, 0) / regs.length : 0;
  const q = regs.find(r => r.bonus > 0 && (S.salary.qMonths || []).includes(ENG.parseM(r.m).m) && ENG.parseM(r.m).m !== +S.salary.y1Month && ENG.parseM(r.m).m !== +S.salary.y2Month);
  return { reg, q: q ? q.bonus : 0 };
}
function renderBudget() {
  const el = $('#tab-budget');
  const s = S.settings, sm = S.salary;
  const num = (path, val, label, help, attrs = '') => field(label, `<input type="text" inputmode="decimal" data-path="${path}" value="${esc(fmtN0(val))}" ${attrs}>`, help);
  const monthSel = (path, val) => `<select data-path="${path}">${MN.map((m, i) => `<option value="${i + 1}" ${+val === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
  const pv = salaryPreview();
  el.innerHTML = `<div class="panel"><h3>Зарплата</h3><p class="sub">Прогноз дохода считается от этих параметров с учётом налога по ступеням. Загруженная расчётка обновляет их сама.</p>
    <div class="form">
      ${num('salary.oklad', sm.oklad, 'Оклад до налога, ₽')}
      ${num('salary.rk', sm.rk, 'Районный коэффициент, %')}
      ${num('salary.sn', sm.sn, 'Северная надбавка, %')}
      ${num('salary.housing', sm.housing, 'Доплата за жильё, ₽ в месяц')}
      <label class="check"><input type="checkbox" data-path="salary.housingOn" ${sm.housingOn !== false ? 'checked' : ''}> Доплата за жильё начисляется</label>
      ${num('salary.salDay', sm.salDay, 'Расчёт приходит до, число')}
      ${num('salary.advDay', sm.advDay, 'Аванс приходит до, число')}
      ${num('salary.advPct', sm.advPct, 'Аванс, % от месячной суммы на руки', 'По расчёткам ≈ 43–47%.')}
    </div>
    <h3 style="margin-top:18px">Премии</h3><p class="sub">Начисляются с районным коэффициентом и северной надбавкой и приходят с расчётом в следующем месяце.</p>
    <div class="form">
      ${num('salary.qPct', sm.qPct, 'Квартальная, % от оклада за квартал')}
      <div class="field"><span class="flabel">Месяцы квартальной</span><div class="chips">${MS.map((m, i) => `<button type="button" class="chip" data-act="qmonth" data-m="${i + 1}" aria-pressed="${(sm.qMonths || []).includes(i + 1)}">${m}</button>`).join('')}</div></div>
      ${field('Годовая, первая выплата — месяц', monthSel('salary.y1Month', sm.y1Month))}
      ${num('salary.y1Mult', sm.y1Mult, 'Размер, окладов')}
      ${field('Годовая, вторая выплата — месяц', monthSel('salary.y2Month', sm.y2Month))}
      ${num('salary.y2Mult', sm.y2Mult, 'Размер, окладов')}
      ${field('Индексация оклада — месяц', monthSel('salary.indexMonth', sm.indexMonth))}
      ${num('salary.indexPct', sm.indexPct, 'Индексация, %', 'В 2025 было +9%, в 2026 +4%. Ноль — без повышения.')}
      <label class="check"><input type="checkbox" data-path="settings.bonusesInPlan" ${s.bonusesInPlan ? 'checked' : ''}> Учитывать премии в плане</label>
    </div>
    <p class="sub" style="margin:12px 0 0" id="salPv">Обычный месяц на руки ≈ <b>${fmt(pv.reg)}</b>${pv.q ? `, квартальная премия на руки ≈ <b>${fmt(pv.q)}</b>` : ''}.</p></div>

    <div class="panel"><div class="ph"><div><h3>Постоянные расходы</h3><p class="sub" style="margin:0">Аренда, парковка, связь — всё, что списывается каждый месяц одной суммой.</p></div><button class="btn" type="button" data-act="add-fixed">Добавить</button></div>
      ${S.fixed.length ? `<div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Что</th><th>Сумма, ₽</th><th>Число</th><th></th></tr></thead><tbody>${S.fixed.map(f => `<tr data-fixed="${f.id}"><td><input type="text" data-f="name" value="${esc(f.name)}"></td><td><input type="text" inputmode="decimal" data-f="amount" value="${esc(fmtN0(f.amount))}"></td><td><input type="number" min="1" max="31" data-f="day" value="${esc(f.day || 1)}" style="max-width:90px"></td><td><button class="btn small ghost danger" type="button" data-act="del-fixed" data-id="${f.id}">Удалить</button></td></tr>`).join('')}</tbody></table></div>` : ''}</div>

    <div class="panel"><h3>Жизнь и запас</h3>
      <div class="form">${num('settings.living', s.living, 'Прочие расходы на жизнь, ₽ в месяц', 'Еда, транспорт, бензин, связь, покупки. Реальную цифру покажет вкладка «Расходы» после загрузки выписок.')}${num('settings.buffer', s.buffer, 'Подушка на счёте, ₽')}${num('settings.cashNow', s.cashNow, 'Свободные деньги на начало месяца, ₽')}
      ${field('При досрочном погашении кредита', `<select data-path="settings.prepayMode"><option value="payment" ${s.prepayMode === 'payment' ? 'selected' : ''}>уменьшать платёж</option><option value="term" ${s.prepayMode === 'term' ? 'selected' : ''}>уменьшать срок</option></select>`)}</div></div>

    <div class="panel"><div class="ph"><div><h3>Разовые поступления и траты</h3><p class="sub" style="margin:0">Ремонт, налоговый вычет, отпуск. Траты — со знаком минус.</p></div><button class="btn" type="button" data-act="add-ev">Добавить</button></div>
      ${S.events.length ? `<div class="tbl-wrap" style="margin-top:12px"><table><thead><tr><th>Месяц</th><th>Число</th><th>Сумма, ₽</th><th>Что это</th><th></th></tr></thead><tbody>${S.events.slice().sort((a, b) => (a.month + String(a.day || 1).padStart(2, '0')) < (b.month + String(b.day || 1).padStart(2, '0')) ? -1 : 1).map(e => `<tr data-ev="${e.id}"><td><input type="month" data-e="month" value="${esc(e.month)}"></td><td><input type="number" min="1" max="31" data-e="day" value="${esc(e.day || 1)}" style="max-width:80px"></td><td><input type="text" inputmode="decimal" data-e="amount" value="${esc(fmtN0(e.amount))}"></td><td><input type="text" data-e="note" value="${esc(e.note || '')}"></td><td><button class="btn small ghost danger" type="button" data-act="del-ev" data-id="${e.id}">Удалить</button></td></tr>`).join('')}</tbody></table></div>` : ''}</div>

    <div class="panel"><h3>Данные и синхронизация</h3>
      <p class="sub">${cloudConfigured ? (session ? `Вход выполнен: ${esc(session.user.email)}. Данные шифруются на устройстве паролем шифрования и только потом отправляются в облако.` : localOnly ? 'Вы работаете без входа: данные хранятся только в этом браузере.' : '') : 'Облако не настроено (файл config.js). Данные хранятся только в этом браузере.'}</p>
      <div class="row-actions"><button class="btn" type="button" data-act="export">Скачать копию данных</button><button class="btn" type="button" data-act="import">Загрузить копию</button>
      ${cloudConfigured && session ? '<button class="btn ghost" type="button" data-act="signout">Выйти</button><button class="btn ghost danger" type="button" data-act="signout-clear">Выйти и стереть данные с устройства</button>' : ''}
      ${cloudConfigured && localOnly ? '<button class="btn primary" type="button" data-act="go-cloud">Войти и включить синхронизацию</button>' : ''}</div></div>`;
}

// ---------- render: salary ----------
const SAL_PARTS = [['sal', 'Оклад с северными', '#3B5BA5'], ['hou', 'Доплата за жильё', '#2A8FB8'], ['trip', 'Командировки', '#8C6A43'], ['vac', 'Отпускные', '#7A4FA0'], ['sick', 'Больничный', '#C0563A'], ['bon', 'Премии с северными', '#0F7A62'], ['oth', 'Прочее', '#6B8E23']];
function renderSalary() {
  const el = $('#tab-salary');
  const P = S.payroll.slice().sort((a, b) => a.m < b.m ? -1 : 1);
  const upBtn = `<button class="btn primary" type="button" data-act="upload-payslip">Загрузить расчётку (PDF)</button>`;
  if (!P.length) { el.innerHTML = `<div class="panel empty">Расчётных листков пока нет.<div style="margin-top:12px">${upBtn}</div></div>`; return; }
  const N = P.length, W = Math.round(Math.max(560, Math.min(1120, (document.documentElement.clientWidth || 1000) - 72))), H = 340, pl = 64, pr = 12, pt = 14, pb = 34;
  const maxV = Math.max(...P.map(r => Object.values(r.p).reduce((a, v) => a + Math.max(0, v), 0)), ...P.map(r => r.net)) * 1.05;
  const bw = (W - pl - pr) / N; const ys = (v) => pt + (H - pt - pb) * (1 - v / maxV);
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = maxV * k / 4; g += `<line x1="${pl}" x2="${W - pr}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(--line)"/><text x="${pl - 8}" y="${ys(v) + 4}" text-anchor="end" font-size="12" fill="var(--ink-3)">${v >= 1e6 ? (v / 1e6).toFixed(1) + ' млн' : Math.round(v / 1e3) + ' т'}</text>`; }
  const lstep = Math.ceil(N / (W < 700 ? 6 : 10));
  P.forEach((r, i) => {
    let y0 = 0; const x = pl + i * bw + bw * 0.15, w = bw * 0.7;
    for (const [k, , c] of SAL_PARTS) { const v = Math.max(0, r.p[k] || 0); if (!v) continue; g += `<rect x="${x.toFixed(1)}" y="${ys(y0 + v).toFixed(1)}" width="${w.toFixed(1)}" height="${(ys(y0) - ys(y0 + v)).toFixed(1)}" fill="${c}" fill-opacity="${r.partial ? '.35' : '.85'}"/>`; y0 += v; }
    if (i % lstep === 0) g += `<text x="${(pl + i * bw + bw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="12" fill="var(--ink-3)">${mShort(r.m)}</text>`;
  });
  let line = ''; P.forEach((r, i) => { line += (i ? 'L' : 'M') + (pl + i * bw + bw / 2).toFixed(1) + ',' + ys(r.net).toFixed(1); });
  g += `<path d="${line}" fill="none" stroke="var(--ink)" stroke-width="2"/>` + P.map((r, i) => `<circle cx="${(pl + i * bw + bw / 2).toFixed(1)}" cy="${ys(r.net).toFixed(1)}" r="3.5" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/>`).join('');
  const full = P.filter(r => !r.partial); const last12 = full.slice(-12);
  const avg = last12.reduce((a, r) => a + r.net, 0) / Math.max(1, last12.length);
  const bon12 = last12.reduce((a, r) => a + (r.p.bon || 0), 0);
  const tax12 = last12.reduce((a, r) => a + r.ndfl, 0) / Math.max(1, last12.reduce((a, r) => a + r.acc, 0));
  const lastR = P[P.length - 1];
  const sch = ENG.incomeSchedule(S, curMonth(), 15).rows;
  const fcRows = sch.map((r, i) => `<tr class="${i === 0 ? 'cur' : ''}"><td class="sticky">${mName(r.m)}</td><td class="num">${fmtN(r.accrual.net)}${r.accrual.fact ? ' <span class="muted">факт</span>' : ''}</td><td class="num">${fmtN(r.salary)}</td><td class="num ${r.bonus > 0.5 ? 'pos' : 'muted'}">${r.bonus > 0.5 ? fmtN(r.bonus) : '—'}</td><td class="num">${r.ev ? fmtN(r.ev) : '—'}</td><td class="num"><b>${fmtN(r.total)}</b></td></tr>`).join('');
  const fcSum = sch.slice(0, 12).reduce((a, r) => a + r.salary + r.bonus, 0);
  const notes = S.payrollNotes || [];
  el.innerHTML = `<div class="panel"><div class="ph"><div><h3>Что приходило на руки</h3><p class="sub" style="margin:0">Столбцы — начисления до налога, линия — на руки после НДФЛ. Бледный столбец — неполная расчётка.</p></div>${upBtn}</div>
    <div class="chart" style="margin-top:12px"><svg viewBox="0 0 ${W} ${H}" id="salSvg" role="img" aria-label="Зарплата по месяцам">${g}<line id="salCur" x1="0" x2="0" y1="${pt}" y2="${H - pb}" stroke="var(--ink)" visibility="hidden"/></svg><div class="tip" id="salTip"></div></div>
    <div class="legend">${SAL_PARTS.map(([, n, c]) => `<span><span class="dot" style="background:${c}"></span>${n}</span>`).join('')}<span><svg width="22" height="10"><line x1="0" x2="22" y1="5" y2="5" stroke="var(--ink)" stroke-width="2"/></svg> на руки</span></div>
    <div class="stats" style="margin-top:14px"><div class="stat"><b>${fmtC(avg)}</b><span>в среднем на руки, ${last12.length ? mShort(last12[0].m) + ' – ' + mShort(last12[last12.length - 1].m) : ''}</span></div><div class="stat"><b>${fmtC(bon12)}</b><span>премий до налога за тот же период</span></div><div class="stat"><b>${(tax12 * 100).toFixed(1).replace('.', ',')}%</b><span>средний НДФЛ</span></div><div class="stat"><b>${fmtC(lastR.net)}</b><span>${mName(lastR.m)}${lastR.partial ? ', неполная' : ''}</span></div></div></div>
    ${notes.length ? `<div class="panel"><h3>Что видно из расчёток</h3><ul class="notes">${notes.map(n => `<li>${esc(n).replace(/&lt;(\/?)b&gt;/g, '<$1b>')}</li>`).join('')}</ul></div>` : ''}
    <div class="panel"><h3>Прогноз дохода</h3><p class="sub">«Начислено на руки» — за месяц работы. «Приходит» — деньги, которые поступают в этом месяце: расчёт за прошлый месяц до ${S.salary.salDay}-го и аванс до ${S.salary.advDay}-го. План погашения считается по поступлениям. За 12 месяцев придёт ${fmtC(fcSum)}.</p>
      <div class="tbl-wrap"><table><thead><tr><th class="sticky">Месяц</th><th class="num">Начислено на руки</th><th class="num">Приходит: зарплата</th><th class="num">Приходит: премия</th><th class="num">Разовые</th><th class="num">Итого приходит</th></tr></thead><tbody>${fcRows}</tbody></table></div></div>`;
  const svg = $('#salSvg'), tip = $('#salTip'), cur = $('#salCur');
  const show = (ev) => {
    const rect = svg.getBoundingClientRect(); const x = (ev.clientX - rect.left) / rect.width * W;
    const i = Math.max(0, Math.min(N - 1, Math.floor((x - pl) / bw))); const r = P[i]; const cx = pl + i * bw + bw / 2;
    cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${mName(r.m)}</b>, ${r.days} из ${r.norm} дн.${r.partial ? ' (неполная)' : ''}<br>Начислено ${fmt(r.acc)}<br>НДФЛ ${fmt(r.ndfl)}<br><b>На руки ${fmt(r.net)}</b>` + SAL_PARTS.filter(([k]) => r.p[k]).map(([k, n, c]) => `<br><span class="dot" style="background:${c}"></span>${n}: ${fmt(r.p[k])}`).join('');
    tip.style.display = 'block'; const px = cx / W * rect.width; tip.style.left = Math.max(100, Math.min(rect.width - 100, px)) + 'px'; tip.style.top = (ys(maxV * 0.95) / H * rect.height) + 'px';
  };
  svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; cur.setAttribute('visibility', 'hidden'); });
}

// ---------- payslip upload ----------
async function uploadPayslips() {
  const files = await pickFiles('application/pdf,.pdf', true); if (!files.length) return;
  toast('Читаю расчётки…');
  let lib; try { lib = await pdfLib(); } catch (e) { toast(e.message); return; }
  const recs = [], errs = [];
  for (const f of files) {
    try { const lines = await PAYSLIP.linesFromPdf(lib, new Uint8Array(await readBuf(f))); const r = PAYSLIP.parse(lines); r.bonusNet = Math.round((r.p.bon || 0) * (r.acc ? r.net / r.acc : 0)); r.file = f.name; recs.push(r); }
    catch (e) { errs.push(`${f.name}: ${e.message === 'not_payslip' || e.message === 'no_items' ? 'не похоже на расчётный лист' : e.message}`); }
  }
  if (!recs.length) { openDialog(`<h3>Не получилось прочитать</h3><p class="sub" style="margin:0">${errs.map(esc).join('<br>')}</p>`, `<button class="btn primary" value="cancel">Понятно</button>`); return; }
  recs.sort((a, b) => a.m < b.m ? -1 : 1);
  const sm = S.salary; const newest = recs[recs.length - 1];
  const latestExisting = S.payroll.reduce((a, r) => r.m > a ? r.m : a, '');
  const isLatest = newest.m >= latestExisting;
  const changes = [];
  if (isLatest && newest.oklad && newest.oklad !== +sm.oklad) changes.push({ key: 'oklad', on: true, text: `Оклад: ${fmtN(sm.oklad)} → ${fmtN(newest.oklad)} ₽` });
  const halfLike = (r) => r.norm && r.days < r.norm * 0.6 && !r.adv;
  if (isLatest && newest.housing && (newest.housing !== +sm.housing || sm.housingOn === false)) changes.push({ key: 'housing', on: true, text: `Доплата за жильё: ${fmtN(newest.housing)} ₽ в месяц${sm.housingOn === false ? ', включить снова' : ''}` });
  if (isLatest && !newest.housing && sm.housingOn !== false && !halfLike(newest)) changes.push({ key: 'housingOff', on: false, text: 'Доплата за жильё в листке не начислена — выключить её в прогнозе' });
  const rowsHtml = recs.map((r, i) => {
    const exists = S.payroll.some(x => x.m === r.m);
    const b = r.bonuses.length ? r.bonuses.map(x => `${esc(x.name)} ${fmtN(x.amt)}`).join(', ') : '—';
    return `<tr><td>${mName(r.m)}${exists ? ' <span class="tag">заменит</span>' : ''}</td><td class="num">${fmtN(r.net)}</td><td class="num">${r.days} / ${r.norm}</td><td>${b}</td><td><label class="check" style="min-height:auto"><input type="checkbox" data-partial="${i}" ${halfLike(r) ? 'checked' : ''}> неполная</label></td></tr>`;
  }).join('');
  openDialog(`<h3>Расчётки: ${recs.length}</h3>
    <div class="tbl-wrap"><table><thead><tr><th>Месяц</th><th class="num">На руки</th><th class="num">Дни</th><th>Премии</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <p class="sub small" style="margin:0">«Неполная» — листок за половину месяца. Такая расчётка не меняет прогноз и будет заменена полной.</p>
    ${changes.length ? `<div><b>Обновить прогноз:</b>${changes.map((c, i) => `<label class="check"><input type="checkbox" data-change="${i}" ${c.on ? 'checked' : ''}> ${esc(c.text)}</label>`).join('')}</div>` : '<p class="sub" style="margin:0">Параметры зарплаты не изменились.</p>'}
    ${errs.length ? `<p class="neg small" style="margin:0">Не прочитаны: ${errs.map(esc).join('; ')}</p>` : ''}`,
    `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Применить</button>`, (v, body) => {
      recs.forEach((r, i) => { r.partial = body.querySelector(`[data-partial="${i}"]`).checked; delete r.file; S.payroll = S.payroll.filter(x => x.m !== r.m); S.payroll.push(r); });
      S.payroll.sort((a, b) => a.m < b.m ? -1 : 1);
      changes.forEach((c, i) => { if (!body.querySelector(`[data-change="${i}"]`).checked) return; if (c.key === 'oklad') sm.oklad = newest.oklad; if (c.key === 'housing') { sm.housing = newest.housing; sm.housingOn = true; } if (c.key === 'housingOff') sm.housingOn = false; });
      // year-to-date anchor for the progressive tax: latest full payslip
      const full = S.payroll.filter(r => !r.partial);
      if (full.length) {
        const L = full[full.length - 1]; const y = L.m.slice(0, 4);
        const rk = full.filter(r => r.m.slice(0, 4) === y).reduce((a, r) => a + (r.trk || 0), 0);
        const all = L.ytdInc || full.filter(r => r.m.slice(0, 4) === y).reduce((a, r) => a + (r.tb || 0) + (r.trk || 0), 0);
        sm.ytdMonth = L.m; sm.ytdRk = rk; sm.ytdBase = Math.max(0, all - rk);
      }
      persistNow(); renderAll(); toast(recs.length === 1 ? `Расчётка за ${mName(recs[0].m)} загружена` : `Загружено расчёток: ${recs.length}`);
    });
}

// ---------- expenses (bank statements) ----------
const CATS = [['Продукты', 1], ['Кафе и рестораны', 1], ['Авто и транспорт', 1], ['Связь и подписки', 1], ['Здоровье', 1], ['Одежда и вещи', 1], ['Дом и быт', 1], ['Развлечения', 1], ['Переводы людям', 1], ['Наличные', 1], ['Прочее', 1], ['Аренда и парковка', 0], ['Платежи по кредитам', 0], ['Свои переводы', 0], ['Поступления', 0]];
const LIVING = new Set(CATS.filter(c => c[1]).map(c => c[0]));
const CAT_COLORS = ['#3B5BA5', '#C27C0E', '#8C6A43', '#2A8FB8', '#C0563A', '#7A4FA0', '#6B8E23', '#A0527F', '#4E6E81', '#5F6B2E', '#9AA5B1'];
const KW = [
  ['Платежи по кредитам', /погашени|кредит|задолженн|рассрочк|минимальн.*плат|ипотек/i],
  ['Свои переводы', /между своими|между счетами|своего счет|собственн.*сч|перевод себе|на свой сч/i],
  ['Аренда и парковка', /аренд|парковочн|паркинг/i],
  ['Продукты', /пят[её]рочк|магнит|перекр[её]ст|лента|ашан|вкусвилл|дикси|spar|спар|монетк|metro|окей|глобус|globus|самокат|samokat|азбука вкуса|верный|красное.{0,3}белое|бристоль|супермаркет|гипермаркет|продукт|grocer|supermarket/i],
  ['Кафе и рестораны', /кафе|ресторан|кофе|coffee|бургер|burger|kfc|rostic|вкусно.{0,3}точка|додо|pizza|пицц|суши|sushi|шоколадниц|теремок|яндекс.?еда|delivery club|фастфуд|fast food|столов|restaurant|cafe/i],
  ['Авто и транспорт', /азс|лукойл|lukoil|роснефть|газпромнефть|gazprom|shell|татнефть|топлив|бензин|такси|taxi|uber|яндекс.?go|ситидрайв|делимобил|автосервис|шиномонтаж|автомойк|автозапчаст|exist|emex|autodoc|гибдд|платон|метрополит|транспорт|ржд|аэрофлот|авиа|s7|победа|fuel/i],
  ['Связь и подписки', /мтс|билайн|мегафон|tele2|теле2|ростелеком|yota|интернет|подписк|яндекс.?плюс|кинопоиск|ivi|okko|spotify|apple\.com|itunes|google|youtube|vk.?музык|литрес|связь/i],
  ['Здоровье', /аптек|apteka|клиник|медицин|стоматолог|анализ|инвитро|гемотест|здрав|pharm|medical/i],
  ['Одежда и вещи', /wildberries|вайлдберри|ozon|озон|lamoda|ламода|zara|спортмастер|decathlon|одежд|обувь|dns|м\.?видео|эльдорадо|ситилинк|яндекс.?маркет|aliexpress/i],
  ['Дом и быт', /леруа|leroy|икеа|ikea|hoff|obi|fix.?price|фикс.?прайс|жкх|жку|коммунал|электроэнерг|водоканал|управляющ|хозтовар/i],
  ['Развлечения', /кино|театр|концерт|steam|playstation|xbox|боулинг|развлеч|ticket|cinema/i],
  ['Наличные', /снятие|банкомат|atm|наличн/i],
  ['Переводы людям', /перевод|сбп|card2card|по номеру телефона/i],
];
function categorize(t) {
  const text = (t.desc + ' ' + (t.bcat || '')).toLowerCase();
  for (const r of S.rules) if (r.k && text.includes(r.k)) return r.c;
  if (t.a > 0) return /между своими|между счетами|своего счет|перевод себе/i.test(text) ? 'Свои переводы' : 'Поступления';
  for (const [c, re] of KW) if (re.test(t.desc)) return c;
  for (const [c, re] of KW) if (t.bcat && re.test(t.bcat)) return c;
  return 'Прочее';
}
function parseCSV(text) {
  const first = text.split(/\r?\n/).slice(0, 10).join('\n');
  const delim = [';', '\t', ','].map(d => [d, (first.match(new RegExp(d === '\t' ? '\t' : '\\' + d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim()));
}
function toISODate(v) {
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  if (typeof v === 'number' && v > 30000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 864e5)); return toISODate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function guessCols(header) {
  const h = header.map(x => String(x || '').toLowerCase().trim());
  const find = (...res) => { for (const re of res) { const i = h.findIndex(x => re.test(x)); if (i >= 0) return i; } return -1; };
  return {
    date: find(/^дата операции/, /дата операц/, /^дата$/, /дата/, /date/),
    amount: find(/^сумма операции$/, /сумма в валюте сч/, /сумма платежа/, /^сумма$/, /сумма операц/, /сумма/, /amount/),
    out: find(/расход/, /списан/, /дебет/), inc: find(/приход/, /поступлен/, /зачислен/),
    desc: find(/описание/, /назначение/, /детали/, /контрагент/, /получатель/, /наименование/, /description/),
    cat: find(/категор/), status: find(/статус/),
  };
}
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) { const g = guessCols(rows[i]); if (g.date >= 0 && (g.amount >= 0 || g.out >= 0) && g.desc >= 0) return i; }
  return 0;
}
async function readStatement(file) {
  const buf = await readBuf(file); const name = file.name.toLowerCase();
  if (/\.xlsx?$/.test(name)) {
    await loadScript('vendor/xlsx.full.min.js');
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  }
  if (/\.pdf$/.test(name)) throw new Error('pdf');
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('\uFFFD')) text = new TextDecoder('windows-1251').decode(buf);
  return parseCSV(text.replace(/^\uFEFF/, ''));
}
async function importStatement() {
  const files = await pickFiles('.csv,.txt,.xlsx,.xls,.pdf', false); if (!files.length) return;
  const file = files[0]; let rows;
  try { rows = await readStatement(file); }
  catch (e) { openDialog(`<h3>Пока не умею этот формат</h3><p class="sub" style="margin:0">${e.message === 'pdf' ? 'PDF-выписки разбираются отдельно под каждый банк — пришлите пример, и я добавлю ваш банк. А пока выгрузите выписку в CSV или Excel: в приложениях Т-Банка, Альфа-Банка и Сбера это есть в разделе выписок.' : esc(e.message)}</p>`, `<button class="btn primary" value="cancel">Понятно</button>`); return; }
  const hi = findHeader(rows); const header = rows[hi] || []; const g = guessCols(header);
  const opts = (sel) => `<option value="-1">—</option>` + header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(String(h).slice(0, 40) || 'столбец ' + (i + 1))}</option>`).join('');
  const sample = rows.slice(hi + 1, hi + 6);
  openDialog(`<h3>Выписка: ${esc(file.name)}</h3><p class="sub" style="margin:0">Проверьте, какие столбцы что означают. Найдено строк: ${rows.length - hi - 1}.</p>
    <div class="form">${field('Дата', `<select name="c_date">${opts(g.date)}</select>`)}${field('Сумма (минус — трата)', `<select name="c_amount">${opts(g.amount)}</select>`)}${field('Или расход отдельно', `<select name="c_out">${opts(g.amount >= 0 ? -1 : g.out)}</select>`)}${field('…и приход отдельно', `<select name="c_inc">${opts(g.amount >= 0 ? -1 : g.inc)}</select>`)}${field('Описание', `<select name="c_desc">${opts(g.desc)}</select>`)}${field('Категория банка', `<select name="c_cat">${opts(g.cat)}</select>`)}${field('Статус', `<select name="c_status">${opts(g.status)}</select>`)}${field('Счёт или карта', `<input type="text" name="src" value="${esc(file.name.replace(/\.[^.]+$/, ''))}">`)}</div>
    <div class="tbl-wrap"><table><tbody>${sample.map(r => `<tr>${r.slice(0, 8).map(c => `<td>${esc(c instanceof Date ? toISODate(c) : String(c).slice(0, 30))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="neg small" id="impErr2" style="margin:0"></p>`, `<button class="btn ghost" value="cancel" formnovalidate>Отмена</button><button class="btn primary" value="ok">Загрузить операции</button>`, (v, b) => {
      const c = (n) => +b.querySelector(`[name=c_${n}]`).value;
      const src = b.querySelector('[name=src]').value.trim() || 'Выписка';
      if (c('date') < 0 || c('desc') < 0 || (c('amount') < 0 && c('out') < 0)) { $('#impErr2').textContent = 'Укажите хотя бы дату, сумму и описание.'; return false; }
      const have = new Set(S.tx.map(t => t.id)); let added = 0, skipped = 0;
      for (const r of rows.slice(hi + 1)) {
        const d = toISODate(r[c('date')]); if (!d) continue;
        if (c('status') >= 0 && /fail|отклон|отмен/i.test(String(r[c('status')]))) { skipped++; continue; }
        let a = c('amount') >= 0 ? parseNum(r[c('amount')]) : (-Math.abs(parseNum(r[c('out')])) + Math.abs(parseNum(c('inc') >= 0 ? r[c('inc')] : 0)));
        if (!a) continue;
        const desc = String(r[c('desc')] || '').trim(); const bcat = c('cat') >= 0 ? String(r[c('cat')] || '').trim() : '';
        const id = (d + '|' + a.toFixed(2) + '|' + desc + '|' + src).split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
        if (have.has(id)) { skipped++; continue; }
        const t = { id, d, a: Math.round(a * 100) / 100, desc, bcat, src }; t.cat = categorize(t);
        S.tx.push(t); have.add(id); added++;
      }
      S.tx.sort((x, y) => x.d < y.d ? 1 : -1);
      const months = [...new Set(S.tx.map(t => t.d.slice(0, 7)))].sort(); if (months.length) expM = months[months.length - 1];
      persistNow(); renderAll(); toast(`Добавлено операций: ${added}${skipped ? `, пропущено: ${skipped}` : ''}`);
    });
}
let expM = null;
function livingByMonth() {
  const out = {};
  for (const t of S.tx) { if (t.a >= 0 || !LIVING.has(t.cat)) continue; const m = t.d.slice(0, 7); out[m] = (out[m] || 0) - t.a; }
  return out;
}
function renderExpenses() {
  const el = $('#tab-expenses');
  const btn = `<button class="btn primary" type="button" data-act="import-statement">Загрузить выписку</button>`;
  if (!S.tx.length) { el.innerHTML = `<div class="panel empty"><p style="margin:0 0 12px">Загрузите выписку из банка в CSV или Excel — приложение разложит траты по категориям и покажет, сколько реально уходит на жизнь.</p>${btn}<p class="sub small" style="margin:12px 0 0">PDF-выписки добавим под ваш банк по примеру.</p></div>`; return; }
  const months = [...new Set(S.tx.map(t => t.d.slice(0, 7)))].sort();
  if (!expM || !months.includes(expM)) expM = months[months.length - 1];
  const tx = S.tx.filter(t => t.d.slice(0, 7) === expM);
  const by = {}; for (const t of tx) if (t.a < 0) by[t.cat] = (by[t.cat] || 0) - t.a;
  const living = Object.entries(by).filter(([c]) => LIVING.has(c)).reduce((a, [, v]) => a + v, 0);
  const lbm = livingByMonth(); const full = months.filter(m => m < curMonth()).slice(-3);
  const avg3 = full.length ? full.reduce((a, m) => a + (lbm[m] || 0), 0) / full.length : 0;
  const maxC = Math.max(1, ...Object.values(by));
  const cats = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v], i) => `<div class="cat-row"><span>${esc(c)}${LIVING.has(c) ? '' : ' <span class="muted">(не жизнь)</span>'}</span><span class="num">${fmt(v)}</span><div class="bar"><i style="width:${v / maxC * 100}%;background:${LIVING.has(c) ? CAT_COLORS[i % CAT_COLORS.length] : 'var(--ink-3)'}"></i></div></div>`).join('');
  const opts = (sel) => CATS.map(([c]) => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  const list = tx.slice(0, 300).map(t => `<tr><td>${dText(t.d)}</td><td>${esc(t.desc)}${t.bcat ? `<div class="muted small">${esc(t.bcat)}</div>` : ''}</td><td class="num ${t.a > 0 ? 'pos' : ''}">${t.a > 0 ? '+' : '−'}${fmtN(Math.abs(t.a))}</td><td><select data-txcat="${t.id}">${opts(t.cat)}</select>${t.cat === 'Платежи по кредитам' && t.a < 0 ? `<button class="btn small" type="button" data-act="tx-pay" data-id="${t.id}">Отметить платёж</button>` : ''}</td></tr>`).join('');
  el.innerHTML = `<div class="panel"><div class="ph"><div><h3>Расходы</h3><p class="sub" style="margin:0">По загруженным выпискам. Платежи по кредитам, переводы между своими счетами, аренда и поступления в «жизнь» не входят.</p></div><div class="row-actions">${btn}</div></div>
    <div class="chips" style="margin-top:12px">${months.map(m => `<button type="button" class="chip" data-act="exp-m" data-m="${m}" aria-pressed="${m === expM}">${mShort(m)}</button>`).join('')}</div>
    <div class="stats" style="margin-top:14px"><div class="stat"><b>${fmtC(living)}</b><span>на жизнь в ${mPrep(expM)}${expM >= curMonth() ? ' (месяц не закончен)' : ''}</span></div><div class="stat"><b>${avg3 ? fmtC(avg3) : '—'}</b><span>в среднем за ${full.length || 0} полн. мес.</span></div><div class="stat"><b>${fmtC(+S.settings.living || 0)}</b><span>заложено в плане</span></div><div class="stat"><b>${tx.length}</b><span>операций за месяц</span></div></div>
    ${avg3 ? `<div class="row-actions" style="margin-top:12px"><button class="btn primary" type="button" data-act="apply-living" data-v="${Math.round(avg3 / 1000) * 1000}">Подставить в план ${fmt(Math.round(avg3 / 1000) * 1000)} в месяц</button></div>` : ''}</div>
    <div class="cols"><div class="panel"><h3>По категориям</h3>${cats || '<p class="sub">Трат нет.</p>'}</div>
    <div class="panel"><h3>Операции</h3><p class="sub">Поменяйте категорию — приложение запомнит её для похожих операций.</p><div class="tbl-wrap" style="max-height:70vh"><table><tbody>${list}</tbody></table></div></div></div>`;
}

// ---------- render all ----------
let activeTab = localStorage.getItem('debtplan.tab') || 'month';
function renderAll(opts = {}) {
  if (activeDebts().length) compute(); else F = { months: [], payoffBy: {}, deadlineMiss: [], deficitMonths: [], debts: [], totalInterest: 0 };
  renderHero(); renderLadder(); renderAlerts();
  const R = { month: renderMonth, calendar: renderCalendar, schedule: renderSchedule, pf: renderPF, debts: renderDebts, expenses: renderExpenses, salary: renderSalary, budget: renderBudget, strategy: renderStrategy };
  for (const [k, fn] of Object.entries(R)) { if (opts.skipBudget && k === 'budget') continue; if (k === activeTab || !opts.lazy) { try { fn(); } catch (e) { console.error(k, e); $('#tab-' + k).innerHTML = `<div class="panel empty">Не удалось показать раздел: ${esc(e.message)}</div>`; } } }
  showTab(activeTab);
}
function showTab(t) {
  activeTab = t; localStorage.setItem('debtplan.tab', t);
  $$('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('section[id^="tab-"]').forEach(s => s.hidden = s.id !== 'tab-' + t);
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; showTab(b.dataset.tab); });

// ---------- income plan / fact (added to the plan & fact tab) ----------
const _renderPF = renderPF;
renderPF = function () {
  _renderPF();
  const bl = S.baseline; if (!bl || !bl.inc) return;
  const facts = {}; for (const r of S.payroll) if (!r.partial) facts[r.m] = r.net;
  const rows = bl.inc.filter(r => r.m <= curMonth() || facts[r.m]).concat(bl.inc.filter(r => r.m > curMonth()).slice(0, 2));
  const html = `<div class="panel"><h3>Доход: план и факт</h3><p class="sub">Начислено на руки за месяц работы: прогноз из зафиксированного плана против загруженных расчёток.</p>
    <div class="tbl-wrap"><table><thead><tr><th class="sticky">Месяц</th><th class="num">План</th><th class="num">Факт</th><th class="num">Разница</th></tr></thead><tbody>${rows.map(r => { const f = facts[r.m]; const d = f != null ? f - r.acc : null; return `<tr><td class="sticky">${mName(r.m)}</td><td class="num">${fmtN(r.acc)}</td><td class="num">${f != null ? fmtN(f) : '<span class="muted">ждём расчётку</span>'}</td><td class="num ${d == null ? 'muted' : d >= 0 ? 'pos' : 'neg'}">${d == null ? '—' : (d >= 0 ? '+' : '−') + fmtN(Math.abs(d))}</td></tr>`; }).join('')}</tbody></table></div></div>`;
  $('#tab-pf').insertAdjacentHTML('beforeend', html);
};

// ---------- events ----------
function setPath(path, value) { const [a, b] = path.split('.'); S[a][b] = value; }
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  switch (act) {
    case 'add-debt': debtDialog(null); break;
    case 'edit-debt': debtDialog(debtById(id)); break;
    case 'pay': payDialog(id, b.dataset.amount ? +b.dataset.amount : '', b.dataset.extra === '1'); break;
    case 'close-debt': {
      const d = debtById(id);
      openDialog(`<h3>Закрыть «${esc(d.name)}»?</h3><p class="sub" style="margin:0">Кредит уйдёт в закрытые и перестанет участвовать в плане. Вернуть его можно в любой момент.${+d.balance > 0 ? ` Сейчас по нему числится ${fmt(d.balance)}.` : ''}</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Закрыть кредит</button>`, () => { d.status = 'closed'; d.closedAt = todayISO(); recordHistory(); persistNow(); renderAll(); toast('Кредит закрыт'); });
      break;
    }
    case 'reopen-debt': { const d = debtById(id); d.status = 'active'; delete d.closedAt; recordHistory(); persistNow(); renderAll(); toast('Кредит снова в плане'); break; }
    case 'del-debt': { const d = debtById(id); openDialog(`<h3>Удалить «${esc(d.name)}» насовсем?</h3><p class="sub" style="margin:0">Платежи по нему останутся в истории.</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Удалить</button>`, () => { S.debts = S.debts.filter(x => x.id !== id); persistNow(); renderAll(); toast('Кредит удалён'); }); break; }
    case 'del-pay': {
      const p = S.payments.find(x => x.id === id); if (!p) break;
      openDialog(`<h3>Удалить платёж ${fmt(p.amount)} от ${dText(p.date)}?</h3><p class="sub" style="margin:0">${fmt(p.principal)} вернутся в остаток «${esc(debtName(p.debtId))}».</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Удалить платёж</button>`, () => {
        S.payments = S.payments.filter(x => x.id !== id); const d = debtById(p.debtId);
        if (d) { d.balance = Math.round(((+d.balance || 0) + (+p.principal || 0)) * 100) / 100; if (d.status === 'closed' && d.balance > 0) { d.status = 'active'; delete d.closedAt; } }
        recordHistory(); persistNow(); renderAll(); toast('Платёж удалён');
      });
      break;
    }
    case 'fix-plan':
      openDialog(`<h3>Зафиксировать новый план?</h3><p class="sub" style="margin:0">Текущий прогноз долгов и дохода станет планом, с которым сравнивается факт. Старый план заменится.</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Зафиксировать</button>`, () => { makeBaseline(); persistNow(); renderAll(); toast('План зафиксирован'); });
      break;
    case 'pf-row': pfOpen = pfOpen === b.dataset.m ? null : b.dataset.m; renderPF(); break;
    case 'strategy': S.settings.strategy = b.dataset.k; if (b.dataset.k === 'manual' && !(S.settings.manualOrder || []).length) S.settings.manualOrder = ENG.order(activeDebts().map(d => ({ ...d, _bal: +d.balance })), 'avalanche', 0, []).map(d => d.id); persistNow(); renderAll(); break;
    case 'ord-up': case 'ord-down': {
      const cur = ENG.order(activeDebts().filter(d => +d.balance > 0).map(d => ({ ...d, _bal: +d.balance })), 'manual', 0, S.settings.manualOrder || []).filter(d => d.kind !== 'deadline' && (+d.rate || 0) > 0).map(d => d.id);
      const i = cur.indexOf(id), j = act === 'ord-up' ? i - 1 : i + 1; if (j < 0 || j >= cur.length) break;
      [cur[i], cur[j]] = [cur[j], cur[i]]; S.settings.manualOrder = cur; persistNow(); renderAll(); break;
    }
    case 'qmonth': { const m = +b.dataset.m; const q = S.salary.qMonths || []; S.salary.qMonths = q.includes(m) ? q.filter(x => x !== m) : q.concat(m).sort((a, c) => a - c); persistNow(); renderAll(); break; }
    case 'add-fixed': S.fixed.push({ id: uid(), name: 'Новый расход', amount: 0, day: 1 }); persistNow(); renderAll(); break;
    case 'del-fixed': S.fixed = S.fixed.filter(x => x.id !== id); persistNow(); renderAll(); break;
    case 'add-ev': S.events.push({ id: uid(), month: ENG.addM(curMonth(), 1), day: 15, amount: 0, note: '' }); persistNow(); renderAll(); break;
    case 'del-ev': S.events = S.events.filter(x => x.id !== id); persistNow(); renderAll(); break;
    case 'cal-k': calK = +b.dataset.k; renderCalendar(); break;
    case 'set-payday': { const d = debtById(id); d.payDay = +b.dataset.day; persistNow(); renderAll(); toast(`«${d.name}»: платить ${d.payDay}-го`); break; }
    case 'upload-payslip': uploadPayslips(); break;
    case 'import-statement': importStatement(); break;
    case 'exp-m': expM = b.dataset.m; renderExpenses(); break;
    case 'apply-living': S.settings.living = +b.dataset.v; persistNow(); renderAll(); toast('Расходы на жизнь в плане обновлены'); break;
    case 'tx-pay': {
      const t = S.tx.find(x => x.id === id); if (!t) break;
      const text = (t.desc + ' ' + (t.bcat || '')).toLowerCase();
      const guess = activeDebts().find(d => d.name.toLowerCase().split(/[·\s]+/).filter(w => w.length > 3).some(w => text.includes(w))) || activeDebts()[0];
      payDialog(guess && guess.id, Math.abs(t.a), false, t.d); break;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `plan-dolgov-${todayISO()}.json`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('Копия скачана'); break;
    }
    case 'import': {
      const files = await pickFiles('.json,application/json', false); if (!files.length) break;
      try { const o = JSON.parse(new TextDecoder().decode(await readBuf(files[0]))); if (!o || !Array.isArray(o.debts)) throw 0;
        openDialog(`<h3>Загрузить копию?</h3><p class="sub" style="margin:0">Текущие данные на этом устройстве${session ? ' и в облаке' : ''} заменятся данными из файла.</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Заменить</button>`, () => { S = normalize(o); recordHistory(); persistNow(); renderAll(); toast('Данные загружены'); });
      } catch (x) { toast('Это не файл копии этого приложения'); }
      break;
    }
    case 'signout': signOut(false); break;
    case 'signout-clear': openDialog(`<h3>Выйти и стереть данные с устройства?</h3><p class="sub" style="margin:0">В облаке данные останутся, их можно будет загрузить после входа.</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Выйти и стереть</button>`, () => { signOut(true); }); break;
    case 'go-cloud': localOnly = false; localStorage.removeItem('debtplan.localOnly'); initSync(); break;
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.path && t.type !== 'checkbox' && t.tagName !== 'SELECT') { setPath(t.dataset.path, parseNum(t.value)); persist(); renderAll({ skipBudget: true }); const pv = salaryPreview(); const el = $('#salPv'); if (el) el.innerHTML = `Обычный месяц на руки ≈ <b>${fmt(pv.reg)}</b>${pv.q ? `, квартальная премия на руки ≈ <b>${fmt(pv.q)}</b>` : ''}.`; }
  else if (t.dataset.f) { const f = S.fixed.find(x => x.id === t.closest('[data-fixed]').dataset.fixed); f[t.dataset.f] = t.dataset.f === 'name' ? t.value : parseNum(t.value); persist(); renderAll({ skipBudget: true }); }
  else if (t.dataset.e) { const ev = S.events.find(x => x.id === t.closest('[data-ev]').dataset.ev); const k = t.dataset.e; ev[k] = k === 'amount' || k === 'day' ? parseNum(t.value) : t.value; persist(); renderAll({ skipBudget: true }); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.path && (t.type === 'checkbox' || t.tagName === 'SELECT')) { const v = t.type === 'checkbox' ? t.checked : (t.dataset.path.endsWith('prepayMode') ? t.value : +t.value); setPath(t.dataset.path, v); persistNow(); renderAll(); }
  else if (t.dataset.txcat) {
    const tx = S.tx.find(x => x.id === t.dataset.txcat); tx.cat = t.value;
    const key = tx.desc.toLowerCase().replace(/\d{3,}/g, '').trim().slice(0, 40);
    if (key.length >= 4) { S.rules = S.rules.filter(r => r.k !== key); S.rules.unshift({ k: key, c: t.value }); for (const x of S.tx) if (x.desc.toLowerCase().includes(key)) x.cat = t.value; }
    persistNow(); renderAll(); toast('Категория запомнена');
  }
  else if (t.dataset.path || t.dataset.e || t.dataset.f) renderBudget();
});
let rzT = null; window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => renderAll({ skipBudget: true }), 250); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
renderAll();
initSync();
})();
