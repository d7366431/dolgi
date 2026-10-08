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
  payees: [], ownContracts: [], limits: DEFAULT_LIMITS(),
});
function DEFAULT_LIMITS() {
  return [
    { id: 'l1', name: 'Продукты', month: 45000, cats: ['Продукты'] },
    { id: 'l2', name: 'Машина', month: 25000, cats: ['Машина'] },
    { id: 'l3', name: 'Кафе и доставка', month: 15000, cats: ['Кафе и доставка'] },
    { id: 'l4', name: 'Подарки и переводы', month: 15000, cats: ['Подарки и переводы'] },
    { id: 'l5', name: 'Покупки', month: 15000, cats: ['Покупки', 'Покупки частями'] },
    { id: 'l6', name: 'Здоровье и спорт', month: 10000, cats: ['Здоровье и спорт'] },
    { id: 'l7', name: 'Такси и связь', month: 10000, cats: ['Такси и связь'] },
    { id: 'l8', name: 'Прочее', month: 15000, cats: ['Прочее'] },
  ];
}
const CAT_REMAP = { 'Кафе и рестораны': 'Кафе и доставка', 'Авто и транспорт': 'Машина', 'Связь и подписки': 'Такси и связь', 'Здоровье': 'Здоровье и спорт', 'Одежда и вещи': 'Покупки', 'Дом и быт': 'Покупки', 'Развлечения': 'Прочее', 'Наличные': 'Прочее', 'Переводы людям': 'Подарки и переводы' };
function normalize(s) {
  const d = DEFAULT();
  s = Object.assign(d, s || {});
  s.settings = Object.assign(DEFAULT().settings, s.settings || {});
  s.salary = Object.assign(DEFAULT().salary, s.salary || {});
  for (const k of ['fixed', 'events', 'debts', 'payments', 'history', 'payroll', 'payrollNotes', 'tx', 'rules', 'payees', 'ownContracts']) if (!Array.isArray(s[k])) s[k] = [];
  if (!Array.isArray(s.limits) || !s.limits.length) s.limits = DEFAULT_LIMITS();
  if ((s.version || 0) < 3) {
    for (const t of s.tx) if (CAT_REMAP[t.cat]) t.cat = CAT_REMAP[t.cat];
    for (const r of s.rules) if (CAT_REMAP[r.c]) r.c = CAT_REMAP[r.c];
    s.payrollNotes = []; s.version = 3;
  }
  s.settings.strategy = s.settings.strategy || 'avalanche';
  s.settings.prepayMode = 'payment'; s.settings.bonusesInPlan = true;
  s.settings.living = s.limits.reduce((a, l) => a + (+l.month || 0), 0);
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
function renderSync() { $$('[data-sync]').forEach(el => { el.className = 'sync' + (sync.state === 'ok' ? ' on' : sync.state === 'error' ? ' err' : '') + (el.dataset.sync === 'dot' ? ' dot-only' : ''); el.title = syncText(); el.innerHTML = '<i></i><span>' + esc(syncText()) + '</span>'; }); }

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
  $('#dlgBody').innerHTML = '<button type="button" class="dlg-x" aria-label="Закрыть окно" data-dlg-close>✕</button>' + html; $('#dlgFoot').innerHTML = foot;
  dlg._submit = onSubmit; dlg.showModal(); if (onMount) onMount($('#dlgBody'));
}
dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-dlg-close]')) dlg.close(); });
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
    const pd = g('date').value || todayISO();
    const twin = S.payments.find(p => p.debtId === d.id && Math.abs(p.amount - amt) < 1 && Math.abs(new Date(p.date) - new Date(pd)) <= 3 * 864e5);
    if (twin && !b.dataset.ok) { b.dataset.ok = '1'; $('#payHint').innerHTML = `<b class="neg">Такой платёж уже внесён ${dText(twin.date)}.</b> Если это другой платёж, нажмите «Сохранить платёж» ещё раз.`; return false; }
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
    const upd = () => { delete b.dataset.ok; const d = debtById(g('debt').value); const amt = parseNum(g('amount').value); const p = estPrincipal(d, amt, g('date').value); g('principal').placeholder = amt ? fmtN0(Math.round(p)) : ''; $('#payHint').textContent = d ? `Остаток сейчас ${fmt(d.balance)} на ${dText(d.balanceDate)}. После платежа ≈ ${fmt(Math.max(0, d.balance - (g('principal').value.trim() ? parseNum(g('principal').value) : p)))}.${d.kind === 'annuity' && S.settings.prepayMode === 'payment' ? ' При досрочном погашении ежемесячный платёж пересчитается пропорционально — сверьте его с банком.' : ''}` : ''; };
    ['debt', 'amount', 'date', 'principal'].forEach(n => g(n).addEventListener('input', upd)); upd();
  });
}
function estPrincipal(d, amt, date) {
  if (!d || !amt) return 0;
  const days = Math.max(0, (new Date(date || todayISO()) - new Date(d.balanceDate || todayISO())) / 864e5);
  const interest = (+d.balance || 0) * (+d.rate || 0) / 100 / 365 * days;
  return Math.max(0, Math.min(+d.balance || 0, amt - interest));
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
// ---------- render: budget ----------
function salaryPreview() {
  const acc = ENG.accrualSeries(S, curMonth(), ENG.addM(curMonth(), 12));
  const regs = Object.values(acc).filter(a => !a.fact);
  const reg = regs.length ? regs.reduce((a, r) => a + r.reg, 0) / regs.length : 0;
  const q = regs.find(r => r.bonus > 0 && (S.salary.qMonths || []).includes(ENG.parseM(r.m).m) && ENG.parseM(r.m).m !== +S.salary.y1Month && ENG.parseM(r.m).m !== +S.salary.y2Month);
  return { reg, q: q ? q.bonus : 0 };
}
// ---------- render: salary ----------
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
async function importStatement(file) {
  let rows;
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
      const have = seenIds(), taken = new Set(), st = { added: 0, skipped: 0, replaced: 0 }; let added = 0, skipped = 0;
      for (const r of rows.slice(hi + 1)) {
        const d = toISODate(r[c('date')]); if (!d) continue;
        if (c('status') >= 0 && /fail|отклон|отмен/i.test(String(r[c('status')]))) { skipped++; continue; }
        let a = c('amount') >= 0 ? parseNum(r[c('amount')]) : (-Math.abs(parseNum(r[c('out')])) + Math.abs(parseNum(c('inc') >= 0 ? r[c('inc')] : 0)));
        if (!a) continue;
        const desc = String(r[c('desc')] || '').trim(); const bcat = c('cat') >= 0 ? String(r[c('cat')] || '').trim() : '';
        const id = (d + '|' + a.toFixed(2) + '|' + desc + '|' + src).split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
        addStatementTx({ id, d, a: Math.round(a * 100) / 100, desc, bcat, src }, have, taken, st);
      }
      added = st.added; skipped += st.skipped; recategorizeAll(); afterTxImport(); persistNow(); renderAll(); toast(`Добавлено операций: ${added}${skipped ? `, пропущено: ${skipped}` : ''}${st.replaced ? `, заменено ручных: ${st.replaced}` : ''}`);
    });
}

// ================= v3: simple phone-first UI =================
const NON_LIVING_BASE = ['Аренда и парковка', 'Платежи по кредитам', 'Проценты по кредитам', 'Свои переводы', 'Сбережения', 'Поступления'];
const livingCats = () => [...new Set(S.limits.flatMap(l => l.cats))];
const isLiving = (c) => S.limits.some(l => l.cats.includes(c));
const allCats = () => [...new Set([...livingCats(), ...NON_LIVING_BASE, ...S.payees.map(p => p.cat).filter(Boolean)])];
const LIMIT_COLORS = ['#3B5BA5', '#C27C0E', '#B5475B', '#7A4FA0', '#2A8FB8', '#6B8E23', '#8C6A43', '#4E6E81', '#0F7A62', '#A0527F'];

// ---------- categorisation ----------
const KW2 = [
  ['Покупки частями', /долями|dolyame|split|chastyami|bnpl|частями/i],
  ['Продукты', /perekrestok|pyaterochka|magnit|lenta|vkusvill|monetka|samokat|spar|ashan|auchan|svetofor|krasnoe|bristol|lavka|пят[её]рочк|магнит|перекр[её]ст|лента|ашан|вкусвилл|дикси|монетк|самокат|верный|красное.{0,3}белое|бристоль|супермаркет|продукт/i],
  ['Кафе и доставка', /kofe|coffee|kafe|cafe|chito|khochu puri|tomyum|gastrobistro|shelby|aziatok|yandex\*eda|sushi|pizza|burger|\bbar\b|bowl|kishmish|leonardo|чаевые|restoran|grill|shaurma|vkusno|teremok|kfc|rostic|stolov|bistro|garden|dodo|кафе|ресторан|кофе|суши|пицц|бургер|додо|теремок|яндекс.?еда/i],
  ['Такси и связь', /yandex\*\d*\*?go|yandex\*go|taxi|citydrive|delimobil|megafon|мегафон|\bmts\b|мтс|beeline|билайн|tele2|теле2|neo mobail|нео мобайл|yota|rostelecom|ростелеком|apple\.com|itunes|google|youtube|кинопоиск|ivi|okko|spotify|такси|подписк/i],
  ['Машина', /azs|lukoil|gazpromneft|rosneft|benzin|avtocentr|avtoservis|autodoc|avtojapan|автоджапан|\bsto\b|motul|ravenol|avtotyun|avtokompleks|zapchast|rulevih|okhlazhdeniya|pokrasim|vivaaparts|maslomart|polaris|moika|shinomontazh|shinnyy|kolesa|avtosteklo|exist|emex|parking|азс|лукойл|роснефть|газпромнефть|бензин|автосервис|шиномонтаж|автомойк|автозапчаст|гибдд/i],
  ['Здоровье и спорт', /aptek|apteka|nvfarm|farm|klinik|stomat|invitro|gemotest|eyekraft|medic|zdrav|fitness|ddx|sport|аптек|клиник|стоматолог|анализ|инвитро|фитнес/i],
  ['Покупки', /avito|ozon|wildberr|\bwb\b|yandex\*market|ym\*|market|lamoda|aliexpress|usabezgranic|dns|mvideo|eldorado|citilink|levi|bugatti|rive gauche|goldapple|miuz|van cliff|bijoux|zara|gloria|ostin|befree|kristal|sokolov|sunlight|cvety|cvetynv|leroy|lemana|ikea|hoff|fix.?price|letoile|maag|mango|yuvelir|авито|озон|вайлдберри|ламода|леруа|икеа|одежд|обувь/i],
];
function payeeOf(t) { const d = t.desc || ''; return S.payees.find(p => p.match && d.includes(p.match)) || null; }
function payeeKey(t) {
  const d = t.desc || '';
  let m = d.match(/\+7\d{10}/); if (m) return m[0];
  m = d.match(/договор[а]?\s+(\d{10})/); if (m && /внутренний перевод на/i.test(d)) return 'договор ' + m[1];
  m = d.match(/\d{4}\*{4,}\d{4}|\*{4,}\d{4}/); if (m) return m[0];
  return null;
}
function catOf(t) {
  const d = t.desc || '', dl = d.toLowerCase(), a = +t.a;
  const p = payeeOf(t); if (p) return { cat: p.cat, payee: p.name };
  for (const r of S.rules) if (r.k && (dl + ' ' + (t.bcat || '').toLowerCase()).includes(r.k)) return { cat: r.c };
  const mc = d.match(/договор[а]?\s+(\d{10})/);
  if (/инвесткопилк/i.test(d)) return { cat: 'Сбережения' };
  if (/перевод себе|между своими|между счетами|своего сч/i.test(d) || (mc && S.ownContracts.includes(mc[1])) || (a > 0 && /внутрибанковский перевод с договора/i.test(d))) return { cat: 'Свои переводы' };
  if (a > 0) return { cat: 'Поступления' };
  if (/проценты по кредиту/i.test(d)) return { cat: 'Проценты по кредитам' };
  if (/досрочное погашение|регулярный платеж|регулярный платёж|перевод на кредитный договор|в других кредитных организациях|погашение кредит|минимальн\S* плат/i.test(d) || (mc && /внутренний перевод на/i.test(d) && /^0/.test(mc[1]))) return { cat: 'Платежи по кредитам' };
  if (/внешний банковский перевод.*(407\d{2}|40802)/i.test(d)) return { cat: 'Прочее' };
  if (/\+7\d{10}/.test(d) || /по номеру карты|на карту другого банка|внешний банковский перевод/i.test(d) || (mc && /внутренний перевод на/i.test(d))) return { cat: 'Подарки и переводы' };
  for (const [c, re] of KW2) if (re.test(d) || (t.bcat && re.test(t.bcat))) return { cat: c };
  return { cat: 'Прочее' };
}
function recategorizeAll() { for (const t of S.tx) if (!t.mc) { const r = catOf(t); t.cat = r.cat; } }
function afterTxImport() {
  // merge micro savings (round-ups) into one line per day per account
  const keep = [], agg = {};
  for (const t of S.tx) {
    if (t.cat === 'Сбережения' && /инвесткопилк/i.test(t.desc) && !t.agg) { const k = t.d + '|' + t.src; (agg[k] = agg[k] || []).push(t); }
    else keep.push(t);
  }
  for (const [k, list] of Object.entries(agg)) {
    const [d, src] = k.split('|'); const id = hash36(d + '|invest|' + src);
    const ex = keep.find(x => x.id === id);
    const sum = list.reduce((a, t) => a + t.a, 0);
    const fresh = list.filter(t => !(ex && (ex.parts || []).includes(t.id)));
    const add = fresh.reduce((a, t) => a + t.a, 0);
    if (ex) { ex.a = Math.round((ex.a + add) * 100) / 100; ex.parts = (ex.parts || []).concat(fresh.map(t => t.id)); ex.desc = `Инвесткопилка (${ex.parts.length})`; }
    else keep.push({ id, d, a: Math.round(sum * 100) / 100, desc: `Инвесткопилка (${list.length})`, src, cat: 'Сбережения', agg: true, parts: list.map(t => t.id) });
  }
  S.tx = keep.sort((x, y) => (x.d + (x.t || '')) < (y.d + (y.t || '')) ? 1 : -1);
}
const dayDiff = (a, b) => Math.round(Math.abs(new Date(a) - new Date(b)) / 864e5);
const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').split(/\s+/).filter(w => w.length >= 4 && !/^(оплата|перевод|внешний|внутренний|операция|номеру|телефона|договор)$/.test(w)));
const sameMerchant = (a, b) => { const A = words(a); for (const w of words(b)) if (A.has(w)) return true; return false; };
function seenIds() { const s = new Set(); for (const t of S.tx) { s.add(t.id); for (const p of t.parts || []) s.add(p); } return s; }
// a statement operation that is already in the data under another source (manual entry, CSV vs PDF of the same card)
function findDuplicate(x, taken) {
  for (const c of S.tx) {
    if (taken.has(c.id) || c.src === x.src || c.agg) continue;
    if (Math.abs(c.a - x.a) > 0.01) continue;
    if (c.src === 'Вручную') { if (dayDiff(c.d, x.d) <= 1) return { c, manual: true }; continue; }
    if (c.d === x.d && sameMerchant(c.desc, x.desc)) return { c, manual: false };
  }
  return null;
}
// returns 'skip' | 'replaced' | 'new'
function addStatementTx(x, have, taken, stats) {
  if (have.has(x.id)) { stats.skipped++; return 'skip'; }
  if (/инвесткопилк/i.test(x.desc)) { const agg = S.tx.find(t => t.agg && t.d === x.d && t.src === x.src); if (agg && !agg.parts) { stats.skipped++; return 'skip'; } }
  const dup = findDuplicate(x, taken);
  if (dup && !dup.manual) { taken.add(dup.c.id); stats.skipped++; return 'skip'; }
  if (dup && dup.manual) { taken.add(dup.c.id); S.tx = S.tx.filter(t => t.id !== dup.c.id); x.cat = dup.c.cat; x.mc = true; stats.replaced++; }
  else x.cat = catOf(x).cat;
  S.tx.push(x); have.add(x.id); stats.added++; return dup ? 'replaced' : 'new';
}
const hash36 = (s) => s.split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);

// ---------- T-Bank PDF statement ("Справка о движении средств") ----------
async function parseTbankPdf(lib, data) {
  const doc = await lib.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
  let isTb = false, contract = null, account = null; const out = []; let cur = null;
  const col = (x) => x < 110 ? 'd1' : x < 190 ? 'd2' : x < 285 ? 'a1' : x < 380 ? 'a2' : x < 490 ? 'desc' : 'card';
  const push = () => { if (cur) out.push(cur); cur = null; };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p); const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      let r = rows.find(r => Math.abs(r.y - y) < 2); if (!r) { r = { y, items: [] }; rows.push(r); }
      r.items.push({ x, s: it.str.trim() });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      const c = {}; for (const it of r.items) { const k = col(it.x); c[k] = (c[k] ? c[k] + ' ' : '') + it.s; }
      const text = r.items.map(i => i.s).join(' ');
      if (/Справка о движении средств/.test(text)) isTb = true;
      if (!contract && /Номер договора:/.test(text)) contract = (text.match(/(\d{10})/) || [])[1] || null;
      if (!account && /Номер лицевого сч/.test(text)) account = (text.match(/(\d{20})/) || [])[1] || null;
      const d1 = c.d1 || '';
      if (/^Дата и время|^операции$/.test(d1)) continue;
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(d1) && c.a2) {
        push();
        const amt = parseFloat(String(c.a2).replace(/[^\d.,+-]/g, '').replace(',', '.'));
        const [dd, mm, yy] = d1.split('.');
        cur = { d: `${yy}-${mm}-${dd}`, a: amt, desc: c.desc || '', card: (c.card || '').replace(/\D/g, ''), t: '' };
        continue;
      }
      if (cur && /^\d{2}:\d{2}$/.test(d1)) { cur.t = d1; if (c.desc) cur.desc += ' ' + c.desc; continue; }
      if (cur && !d1 && c.desc && !c.a1 && !c.a2) { cur.desc += ' ' + c.desc; continue; }
      if (cur && d1) push();
    }
  }
  push();
  if (!isTb || !out.length) throw new Error('not_tbank');
  const cards = {}; out.forEach(t => { if (t.card) cards[t.card] = (cards[t.card] || 0) + 1; });
  const card = Object.entries(cards).sort((a, b) => b[1] - a[1])[0];
  const kind = account && account.startsWith('408') ? 'дебетовая' : 'кредитная карта';
  const src = `Т-Банк, ${kind}${card ? ' ··' + card[0] : ''}`;
  return { src, contract, tx: out.map(t => ({ ...t, desc: t.desc.replace(/\s+/g, ' ').trim(), src })) };
}
async function importStatements() {
  const files = await pickFiles('.pdf,.csv,.txt,.xlsx,.xls', true); if (!files.length) return;
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name)), others = files.filter(f => !/\.pdf$/i.test(f.name));
  let added = 0, skipped = 0; const fails = [];
  if (pdfs.length) {
    toast('Читаю выписки…');
    let lib; try { lib = await pdfLib(); } catch (e) { toast(e.message); return; }
    const have = seenIds(), taken = new Set(), st = { added: 0, skipped: 0, replaced: 0 };
    for (const f of pdfs) {
      try {
        const r = await parseTbankPdf(lib, new Uint8Array(await readBuf(f)));
        if (r.contract && !S.ownContracts.includes(r.contract)) S.ownContracts.push(r.contract);
        for (const t of r.tx) {
          const id = hash36(t.d + '|' + t.a.toFixed(2) + '|' + t.desc + '|' + t.src + '|' + t.t);
          addStatementTx({ id, d: t.d, t: t.t, a: Math.round(t.a * 100) / 100, desc: t.desc, src: t.src }, have, taken, st);
        }
      } catch (e) { fails.push(f.name); }
    }
    added = st.added; skipped = st.skipped;
    recategorizeAll(); afterTxImport(); persistNow(); renderAll();
    if (fails.length) openDialog(`<h3>Не все файлы прочитаны</h3><p class="sub" style="margin:0">Добавлено операций: ${added}. Не удалось прочитать: ${fails.map(esc).join(', ')}. Сейчас приложение понимает PDF-справки Т-Банка о движении средств, а также CSV и Excel из любого банка. Для другого банка пришлите пример PDF — добавлю.</p>`, `<button class="btn primary" value="cancel">Понятно</button>`);
    else toast(`Добавлено операций: ${added}${skipped ? `, уже были: ${skipped}` : ''}${st.replaced ? `, заменено ручных: ${st.replaced}` : ''}`);
  }
  if (others.length) importStatement(others[0]);
}

// ---------- weeks & spending ----------
const isoOf = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
function weekRange(offset = 0) {
  const t = new Date(); t.setHours(12, 0, 0, 0);
  const dow = (t.getDay() + 6) % 7; const mon = new Date(t); mon.setDate(t.getDate() - dow + offset * 7);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { from: isoOf(mon), to: isoOf(sun), mon, sun };
}
function monthRange(offset = 0) { const m = ENG.addM(curMonth(), offset); return { from: m + '-01', to: m + '-' + String(dim(m)).padStart(2, '0'), m }; }
const weekShare = 12 / 52;
function spendIn(from, to) {
  const byCat = {}; let living = 0;
  for (const t of S.tx) {
    if (t.d < from || t.d > to) continue;
    byCat[t.cat] = (byCat[t.cat] || 0) - t.a;
    if (isLiving(t.cat)) living -= t.a;
  }
  const groups = S.limits.map((l, i) => ({ ...l, color: LIMIT_COLORS[i % LIMIT_COLORS.length], spent: l.cats.reduce((a, c) => a + (byCat[c] || 0), 0) }));
  return { byCat, living, groups };
}
const lastStatementDate = () => S.tx.filter(t => t.src !== 'Вручную').reduce((a, t) => t.d > a ? t.d : a, '');
const rangeLabel = (from, to) => { const [y1, m1, d1] = from.split('-').map(Number), [y2, m2, d2] = to.split('-').map(Number); return m1 === m2 ? `${d1}–${d2} ${MG[m2 - 1]}` : `${d1} ${MG[m1 - 1]} – ${d2} ${MG[m2 - 1]}`; };

// ---------- auto strategy ----------
function pickStrategy() {
  let best = null;
  for (const k of ['avalanche', 'hybrid', 'snowball']) {
    const r = ENG.simulate(S, simOpts({ strategy: k }));
    if (!best || r.totalInterest < best.r.totalInterest - 1000) best = { k, r };
  }
  S.settings.strategy = best.k; F = best.r; return F;
}
function extraTarget() { for (const r of F.months) { const e = Object.entries(r.extraPay).sort((a, b) => b[1] - a[1])[0]; if (e && e[1] > 0.5) return { id: e[0], m: r.m }; } return null; }

// ---------- small UI helpers ----------
const bar = (v, max, color) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, max > 0 ? v / max * 100 : 0))}%;background:${color}"></i></div>`;
const shortDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MS[m - 1]}`; };
let chartHi = null, chartSel = null;
let chartStep = localStorage.getItem('debtplan.chartStep') || '2w';
// ---- discrete debt timeline: balances per debt at chosen dates (week / 2 weeks / month ends) ----
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoOf(d); };
function debtTimeline() {
  const today = todayISO(), cm = curMonth(), sm = S.salary;
  const ids = F.debts.filter(id => F.months.some(r => r.bal[id] > 0.5) || (+(debtById(id) || {}).balance > 0));
  const payParts = (k) => { // planned payments of month k as [{id, day, amt}]
    const r = F.months[k]; if (!r) return []; const m = r.m, n = dim(m), parts = [];
    for (const id of Object.keys(r.pay)) {
      const d = debtById(id); const day = Math.min(+((d && (d.payDay || d.dueDay)) || 28), n);
      const mn = r.minPay[id] || 0, ex = r.extraPay[id] || 0;
      if (mn > 0.5) parts.push({ id, day, amt: mn });
      if (ex > 0.5) parts.push({ id, day: Math.min(n, Math.max(day, (+sm.salDay || 10) + 1)), amt: ex });
    }
    return parts;
  };
  const cache = {};
  const balancesAt = (iso) => {
    const m = iso.slice(0, 7), day = +iso.slice(8, 10), k = ENG.diffM(cm, m);
    if (k < 0 || k >= F.months.length) return null;
    if (!cache[k]) cache[k] = payParts(k);
    const r = F.months[k], out = {};
    for (const id of ids) {
      const start = k === 0 ? +((debtById(id) || {}).balance || 0) : (F.months[k - 1].bal[id] || 0);
      const end = r.bal[id] || 0;
      const parts = cache[k].filter(p => p.id === id); const paidAll = parts.reduce((a, p) => a + p.amt, 0);
      const interest = end - start + paidAll;
      const tday = k === 0 ? +today.slice(8, 10) : 0;
      const due = parts.filter(p => p.day <= day || (k === 0 && p.day <= tday));
      const paid = due.reduce((a, p) => a + p.amt, 0);
      const firstDay = parts.length ? Math.min(...parts.map(p => p.day)) : dim(m);
      out[id] = Math.max(0, start + (day >= firstDay || (k === 0 && firstDay <= tday) ? interest : 0) - paid);
      if (day >= dim(m)) out[id] = end;
    }
    return out;
  };
  const planAt = (iso) => {
    const bl = S.baseline; if (!bl) return null;
    const m = iso.slice(0, 7), k = ENG.diffM(bl.start, m); if (k < 0) return null;
    const prev = k === 0 ? bl.startTotal : (bl.rows[k - 1] || {}).bal; const end = (bl.rows[k] || {}).bal;
    if (prev == null || end == null) return prev == null ? null : prev;
    let frac = +iso.slice(8, 10) / dim(m);
    const row = bl.rows[k];
    if (row && row.payTotal > 0) { const dd = +iso.slice(8, 10); let due = 0; for (const [id, v] of Object.entries(row.pay)) { const d = debtById(id); const pd = Math.min(+((d && (d.payDay || d.dueDay)) || 28), dim(m)); if (pd <= dd) due += v; } frac = dd >= dim(m) ? 1 : due / row.payTotal; }
    return prev + (end - prev) * frac;
  };
  const factAt = (iso) => { let v = null; for (const h of S.history) if (h.d <= iso) v = h.t; return v; };
  // point dates
  const pts = []; const lastM = F.payoff || F.months[F.months.length - 1].m;
  const end = lastM + '-' + String(dim(lastM)).padStart(2, '0');
  const step = chartStep === 'w' ? 7 : chartStep === '2w' ? 14 : 0;
  const sunday = (iso) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return isoOf(d); };
  const blStart = S.baseline ? S.baseline.start + '-01' : today;
  if (step) {
    let p = sunday(today); const past = [];
    for (let q = addDays(p, -step); q >= blStart && past.length < 8; q = addDays(q, -step)) past.unshift(q);
    pts.push(...past.map(d => ({ d, past: true })));
    pts.push({ d: today, now: true });
    if (p === today) p = addDays(p, step);
    for (; p <= addDays(end, step) && pts.length < 80; p = addDays(p, step)) pts.push({ d: p });
  } else {
    let m = S.baseline && S.baseline.start < cm ? S.baseline.start : cm;
    for (; m < cm; m = ENG.addM(m, 1)) pts.push({ d: m + '-' + String(dim(m)).padStart(2, '0'), past: true });
    pts.push({ d: today, now: true });
    for (m = cm; m <= ENG.addM(lastM, 1) && pts.length < 80; m = ENG.addM(m, 1)) { const e = m + '-' + String(dim(m)).padStart(2, '0'); if (e > today) pts.push({ d: e }); }
  }
  for (const p of pts) {
    p.plan = planAt(p.d);
    if (p.past) { p.fact = factAt(p.d); p.total = p.fact; p.per = null; }
    else if (p.now) { p.per = {}; for (const id of ids) p.per[id] = +((debtById(id) || {}).balance || 0); p.total = totalDebt(); p.fact = p.total; }
    else { p.per = balancesAt(p.d) || {}; p.total = Object.values(p.per).reduce((a, v) => a + v, 0); }
  }
  // trim trailing zero points (keep one)
  while (pts.length > 2 && pts[pts.length - 1].total < 1 && pts[pts.length - 2].total < 1) pts.pop();
  return { pts, ids };
}
const ptLabel = (p) => { const [y, m, d] = p.d.split('-').map(Number); if (p.now) return `Сегодня, ${d} ${MG[m - 1]}`; if (chartStep === 'm') return `На конец ${MG[m - 1]} ${y}`; return `На ${d} ${MG[m - 1]}${y !== new Date().getFullYear() ? ' ' + y : ''}`; };
const ptShort = (p) => { const [y, m, d] = p.d.split('-').map(Number); return chartStep === 'm' ? MS[m - 1] + (m === 1 ? ' ' + String(y).slice(2) : '') : `${d}.${String(m).padStart(2, '0')}`; };
let tlCache = null;
function debtChartHTML() {
  const tl = debtTimeline(); tlCache = tl;
  const { pts, ids } = tl;
  const order = ids.slice().sort((a, b) => (F.payoffBy[b] || '9999') < (F.payoffBy[a] || '9999') ? -1 : 1);
  tl.order = order;
  const nowIdx = pts.findIndex(p => p.now); if (chartSel == null || chartSel >= pts.length) chartSel = nowIdx;
  const cw = Math.max(300, Math.min(720, (document.documentElement.clientWidth || 400) - 60));
  const W = Math.round(cw), H = W < 500 ? 220 : 280, pl = 40, pr = 6, pt = 12, pb = 24;
  const N = pts.length, maxV = Math.max(1, ...pts.map(p => Math.max(p.total || 0, p.plan || 0, p.fact || 0))) * 1.06;
  const slot = (W - pl - pr) / N, bw = Math.max(2, Math.min(26, slot * (N > 40 ? 0.72 : 0.62)));
  const cx = (i) => pl + slot * (i + 0.5), ys = (v) => pt + (H - pt - pb) * (1 - v / maxV);
  let g = '';
  const stepV = maxV > 3e6 ? 1e6 : maxV > 1.2e6 ? 5e5 : 2e5;
  for (let v = 0; v <= maxV; v += stepV) g += `<line x1="${pl}" x2="${W - pr}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}" stroke="var(--line)"/><text x="${pl - 5}" y="${(ys(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--ink-3)">${v === 0 ? '0' : v >= 1e6 ? (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн' : Math.round(v / 1e3) + ' т'}</text>`;
  // selection band
  g += `<rect x="${(cx(chartSel) - slot / 2).toFixed(1)}" y="${pt}" width="${slot.toFixed(1)}" height="${H - pt - pb}" fill="var(--accent)" fill-opacity=".10" rx="4"/>`;
  pts.forEach((p, i) => {
    const x = cx(i) - bw / 2; const sel = i === chartSel;
    if (p.past || !p.per) { if (p.total != null) g += `<rect x="${x.toFixed(1)}" y="${ys(p.total).toFixed(1)}" width="${bw.toFixed(1)}" height="${(ys(0) - ys(p.total)).toFixed(1)}" fill="var(--ink-3)" fill-opacity="${sel ? .9 : .55}" rx="${Math.min(3, bw / 3)}"/>`; return; }
    let y0 = 0;
    for (const id of order) {
      const v = p.per[id] || 0; if (v < 1) continue;
      const dimmed = chartHi && chartHi !== id;
      g += `<rect x="${x.toFixed(1)}" y="${ys(y0 + v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, ys(y0) - ys(y0 + v)).toFixed(1)}" fill="${debtColor(id)}" fill-opacity="${dimmed ? .15 : sel ? 1 : .78}"/>`;
      y0 += v;
    }
  });
  // plan as a dashed step line
  let pl2 = ''; pts.forEach((p, i) => { if (p.plan == null) return; const y = ys(p.plan).toFixed(1); pl2 += (pl2 ? `L${(cx(i) - slot / 2).toFixed(1)},${y}` : `M${(cx(i) - slot / 2).toFixed(1)},${y}`) + `L${(cx(i) + slot / 2).toFixed(1)},${y}`; });
  if (pl2) g += `<path d="${pl2}" fill="none" stroke="var(--ink)" stroke-opacity=".75" stroke-width="2" stroke-dasharray="5 4"/>`;
  // fact markers
  pts.forEach((p, i) => { if (p.fact != null) g += `<circle cx="${cx(i).toFixed(1)}" cy="${ys(p.fact).toFixed(1)}" r="4" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/>`; });
  // x labels: today, selected and a few evenly spaced
  const want = new Set([0, nowIdx, N - 1]); const every = Math.max(1, Math.round(N / (W < 500 ? 4 : 7))); for (let i = 0; i < N; i += every) want.add(i);
  const used = []; for (const i of [...want].sort((a, b) => a - b)) { const x = cx(i); if (used.some(u => Math.abs(u - x) < 34)) continue; used.push(x); g += `<text x="${x.toFixed(1)}" y="${H - 7}" text-anchor="${x > W - 30 ? 'end' : x < pl + 20 ? 'start' : 'middle'}" font-size="11" fill="var(--ink-3)">${i === nowIdx ? 'сейчас' : ptShort(pts[i])}</text>`; }
  // selected marker
  const sp = pts[chartSel];
  g += `<line x1="${cx(chartSel).toFixed(1)}" x2="${cx(chartSel).toFixed(1)}" y1="${pt}" y2="${ys(sp.total || 0).toFixed(1)}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="2 3"/>`;
  tl.geo = { W, slot, pl, N };
  const legend = order.map(id => `<button type="button" class="lg${chartHi === id ? ' on' : ''}${chartHi && chartHi !== id ? ' dim' : ''}" data-act="chart-hi" data-id="${id}"><span class="dot" style="background:${debtColor(id)}"></span><span class="lg-n">${esc(debtName(id))}</span><span class="lg-v" data-id="${id}"></span></button>`).join('');
  return `<div class="seg seg3"><button type="button" data-act="chart-step" data-s="w" aria-pressed="${chartStep === 'w'}">Неделя</button><button type="button" data-act="chart-step" data-s="2w" aria-pressed="${chartStep === '2w'}">2 недели</button><button type="button" data-act="chart-step" data-s="m" aria-pressed="${chartStep === 'm'}">Месяц</button></div>
    <div class="dc-metrics" id="dcMetrics"></div>
    <div class="chart" id="dcWrap"><svg viewBox="0 0 ${W} ${H}" width="100%" class="debt-chart" id="dcSvg" role="img" aria-label="Остаток долга по датам">${g}</svg></div>
    <div class="lg-keys"><span><svg width="22" height="8"><line x1="0" x2="22" y1="4" y2="4" stroke="currentColor" stroke-width="2" stroke-dasharray="5 4"/></svg> план</span><span><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg> факт</span><span><svg width="10" height="10"><rect width="10" height="10" rx="2" fill="currentColor" opacity=".55"/></svg> прошлое</span><span>цвет — прогноз по кредитам</span></div>
    <div class="legend2">${legend}</div>`;
}
function fillChartInfo() {
  const tl = tlCache; if (!tl) return; const p = tl.pts[chartSel], prev = tl.pts[chartSel - 1], bl = S.baseline;
  const el = $('#dcMetrics'); if (!el) return;
  const tot = p.total || 0; const ch = prev && prev.total != null ? tot - prev.total : null;
  const per = chartStep === 'w' ? 'за неделю' : chartStep === '2w' ? 'за 2 недели' : 'за месяц';
  const diff = p.plan != null ? p.plan - tot : null;
  const paid = bl ? bl.startTotal - tot : null;
  const left = F.payoff ? Math.max(0, ENG.diffM(p.d.slice(0, 7), F.payoff)) : null;
  let unmarked = '';
  if (p.now && F.months[0]) { const td = new Date().getDate(); const list = Object.keys(F.months[0].minPay).filter(id => { const d = debtById(id); return d && d.kind !== 'deadline' && (F.months[0].minPay[id] || 0) > 0.5 && Math.min(+(d.payDay || d.dueDay) || 28, dim(curMonth())) < td; }); if (list.length) unmarked = `<p class="small neg" style="margin:6px 0 0">Не отмечены прошедшие платежи: ${list.map(id => esc(debtName(id))).join(', ')}. Если вы их внесли, нажмите «Оплачено» в «Платежах» — план и факт сравняются.</p>`; }
  el.innerHTML = `<div class="row-between"><b class="dc-date">${ptLabel(p)}</b>${chartSel !== tl.pts.findIndex(x => x.now) ? '<button type="button" class="btn tiny ghost" data-act="chart-now">к сегодня</button>' : ''}</div>
    <div class="dc-grid">
      <div><span class="label">Долг</span><b>${fmtC(tot)}</b>${ch != null && Math.abs(ch) >= 1 ? `<span class="small ${ch < 0 ? 'pos' : 'neg'}">${ch < 0 ? '−' : '+'}${fmtC(Math.abs(ch))} ${per}</span>` : ''}</div>
      <div><span class="label">План</span><b>${p.plan != null ? fmtC(p.plan) : '—'}</b>${diff != null && Math.abs(diff) >= 1000 ? `<span class="small ${diff >= 0 ? 'pos' : 'neg'}">${diff >= 0 ? 'лучше на ' : 'хуже на '}${fmtC(Math.abs(diff))}</span>` : ''}</div>
      <div><span class="label">Погашено</span><b>${paid != null ? fmtC(Math.max(0, paid)) : '—'}</b>${bl ? `<span class="small muted">из ${fmtC(bl.startTotal)}</span>` : ''}</div>
      <div><span class="label">До конца долгов</span><b>${left != null ? (left === 0 ? 'меньше месяца' : left + ' ' + plural(left, ['месяц', 'месяца', 'месяцев'])) : '—'}</b></div>
    </div>${unmarked}`;
  $$('.lg-v').forEach(v => { const id = v.dataset.id; if (p.per) { const b = p.per[id] || 0; v.textContent = b > 0.5 ? fmtC(b) : 'закрыт ✓'; } else { const d = debtById(id); v.textContent = '—'; } });
}
function bindDebtChart() {
  const svg = $('#dcSvg'); if (!svg || !tlCache) return; fillChartInfo();
  const { W, slot, pl, N } = tlCache.geo;
  const pick = (ev) => { const rect = svg.getBoundingClientRect(); const x = (ev.clientX - rect.left) / rect.width * W; const i = Math.max(0, Math.min(N - 1, Math.floor((x - pl) / slot))); if (i !== chartSel) { chartSel = i; const card = svg.closest('section'); const y = window.scrollY; card.querySelector('.dc-body').innerHTML = debtChartHTML(); window.scrollTo(0, y); bindDebtChart(); } };
  svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && e.buttons === 0) pick(e); });
}
function criticalAlerts() {
  const out = [];
  for (const miss of F.deadlineMiss) { const d = debtById(miss.id); out.push({ lvl: 'danger', t: `К сроку «${esc(d ? d.name : '')}» не хватит ≈ ${fmt(miss.amount)}`, d: `Срок — ${mName(miss.m)}. Все свободные деньги до срока уже откладываются. Остаток закроется в ${F.payoffBy[miss.id] ? mPrep(F.payoffBy[miss.id]) : 'следующих месяцах'}. Договоритесь о переносе этой части или сократите траты до срока.` }); }
  if (F.deficitMonths.length) out.push({ lvl: 'danger', t: `Не хватает на обязательные платежи: ${F.deficitMonths.slice(0, 2).map(mName).join(', ')}`, d: 'Это риск просрочки. Проверьте расходы и суммы платежей.' });
  try { const c = calendarFor(0); const td = new Date().getDate(); const fut = c ? c.byDay.filter(x => x.d >= td) : []; if (c && fut.length) { const mn = fut.reduce((a, x) => x.bal < a.bal ? x : a, fut[0]); c.minBal = mn.bal; c.minDay = mn.d; } if (c && fut.length && c.minBal < 0) out.push({ lvl: 'warn', t: `${c.minDay} ${MG[ENG.parseM(c.cm).m - 1]} на счёте не хватит ≈ ${fmt(-c.minBal)}`, d: 'Перенесите платёж на день после зарплаты или отложите деньги заранее. Подробнее — «Платежи» → «По дням». Если на счетах есть свободные деньги, укажите их в «Ещё» → «Настройки».' }); } catch (e) {}
  return out;
}
const alertsHTML = (list) => list.map(a => `<details class="alert ${a.lvl}"><summary>${a.t}</summary><div>${a.d}</div></details>`).join('');

// ---------- view: Today ----------
function viewToday() {
  const el = $('#v-today');
  if (!activeDebts().length && !S.tx.length) { el.innerHTML = `<div class="card empty"><p>Добавьте кредиты на вкладке «Платежи» или загрузите копию данных в «Ещё» → «Настройки».</p></div>`; return; }
  const w = weekRange(0); const sp = spendIn(w.from, w.to);
  const wl = S.limits.reduce((a, l) => a + l.month, 0) * weekShare; const left = wl - sp.living;
  const today = new Date(); const daysLeft = 7 - ((today.getDay() + 6) % 7);
  const last = lastStatementDate(); const stale = !last || (Date.now() - new Date(last).getTime()) > 2.5 * 864e5;
  const top = sp.groups.filter(g => g.month > 0).sort((a, b) => b.spent / (b.month || 1) - a.spent / (a.month || 1)).slice(0, 4);
  const week = `<section class="card hero-card">
    <div class="row-between"><span class="label">Неделя · ${rangeLabel(w.from, w.to)}</span><span class="label">${daysLeft} ${plural(daysLeft, ['день', 'дня', 'дней'])} до конца</span></div>
    <div class="big ${left < 0 ? 'neg' : ''}">${left < 0 ? '−' : ''}${fmtN(Math.abs(left))} ₽</div>
    <div class="sub">${left >= 0 ? `осталось из ${fmtN(wl)} ₽ · ≈ ${fmtN(left / daysLeft)} ₽ в день` : `перерасход недельного лимита ${fmtN(wl)} ₽`}</div>
    ${bar(sp.living, wl, left < 0 ? 'var(--danger)' : 'var(--accent)')}
    <div class="cats">${top.map(g => { const gl = g.month * weekShare; return `<div class="cat"><div class="row-between"><span>${esc(g.name)}</span><span class="${g.spent > gl ? 'neg' : 'muted'}">${fmtN(g.spent)} / ${fmtN(gl)}</span></div>${bar(g.spent, gl, g.spent > gl ? 'var(--danger)' : g.color)}</div>`; }).join('')}</div>
    <div class="actions"><button class="btn primary" type="button" data-act="quick-add">+ Трата</button><button class="btn" type="button" data-act="import-statements">Загрузить выписку</button></div>
    <p class="hint">${last ? `Выписки загружены по ${shortDate(last)}.` : 'Выписки ещё не загружены.'}${stale ? ' Загрузите свежую, чтобы остаток был точным.' : ''}</p>
  </section>`;
  // upcoming payments (next 10 days)
  let up = '';
  if (activeDebts().length) {
    const cm = curMonth(), nm = ENG.addM(cm, 1); const d0 = today.getDate(); const items = [];
    const add = (m, r, offset) => { if (!r) return; for (const id of Object.keys(r.pay)) { const d = debtById(id); if (!d) continue; const amt = r.pay[id]; if (amt < 1) continue; const day = Math.min(+(d.payDay || d.dueDay || 28), dim(m)); const rel = offset + day - d0; if (rel >= 0 && rel <= 10) items.push({ rel, day, m, d, amt, extra: (r.extraPay[id] || 0) > 0.5 }); } };
    add(cm, F.months[0], 0); add(nm, F.months[1], dim(cm));
    for (const f of S.fixed) { for (const [m, off] of [[cm, 0], [nm, dim(cm)]]) { const day = Math.min(+f.day || 1, dim(m)); const rel = off + day - d0; if (rel >= 0 && rel <= 10) items.push({ rel, day, m, fixed: f, amt: +f.amount }); } }
    items.sort((a, b) => a.rel - b.rel);
    up = `<section class="card"><h2>Ближайшие платежи</h2>${items.length ? items.map(i => `<div class="li"><div class="date"><b>${i.day}</b><span>${MS[ENG.parseM(i.m).m - 1]}</span></div><div class="grow"><div>${i.d ? `<span class="dot" style="background:${i.d.color}"></span>${esc(i.d.name)}` : esc(i.fixed.name)}</div>${i.extra ? '<div class="small pos">включая досрочный платёж</div>' : ''}</div><div class="num"><b>${fmtN(i.amt)}</b>${i.d ? `<button class="btn tiny" type="button" data-act="pay" data-id="${i.d.id}" data-amount="${Math.round(i.amt)}">Оплачено</button>` : ''}</div></div>`).join('') : '<p class="sub">В ближайшие 10 дней платежей нет.</p>'}</section>`;
  }
  // debt chart
  let dc = '';
  if (activeDebts().length) {
    const bl = S.baseline; const target = extraTarget();
    const paid = bl ? Math.max(0, bl.startTotal - totalDebt()) : 0;
    let delta = '';
    if (bl) { const cm = curMonth(); const k = ENG.diffM(bl.start, cm); const planBal = k <= 0 ? bl.startTotal : (bl.rows[k - 1] || {}).bal; if (planBal != null) { const dlt = planBal - totalDebt(); if (Math.abs(dlt) > 5000) delta = `<span class="${dlt > 0 ? 'pos' : 'neg'}">${dlt > 0 ? 'опережаете план на ' : 'отстаёте от плана на '}${fmtC(Math.abs(dlt))}</span>`; } }
    dc = `<section class="card"><div class="row-between"><h2>Как тают долги</h2><span class="label">без долгов ${F.payoff ? 'к ' + mDat(F.payoff) : '—'}</span></div>
      <div class="dc-body">${debtChartHTML()}</div>
      <p class="sub" style="margin:8px 0 0">${target ? `Досрочно гасим: <b>${esc(debtName(target.id))}</b>${target.m !== curMonth() ? ` (с ${mGen(target.m)})` : ''}. ` : ''}${delta}</p></section>`;
  }
  const al = criticalAlerts();
  el.innerHTML = week + up + dc + (al.length ? `<section class="card"><h2>Уведомления</h2>${alertsHTML(al)}</section>` : '');
  bindDebtChart();
}

// ---------- view: Expenses ----------
let exMode = 'week', exOff = 0, exFilter = null, exAll = false;
function viewExpenses() {
  const el = $('#v-expenses');
  const r = exMode === 'week' ? weekRange(exOff) : monthRange(exOff);
  const sp = spendIn(r.from, r.to); const factor = exMode === 'week' ? weekShare : 1;
  const lim = S.limits.reduce((a, l) => a + l.month, 0) * factor;
  const label = exMode === 'week' ? rangeLabel(r.from, r.to) : mName(r.m);
  const rows = sp.groups.map(g => { const gl = g.month * factor; return `<button type="button" class="cat-btn${exFilter === g.id ? ' on' : ''}" data-act="ex-filter" data-id="${g.id}"><div class="row-between"><span><span class="dot" style="background:${g.color}"></span>${esc(g.name)}</span><span class="${g.spent > gl ? 'neg' : ''}">${fmtN(g.spent)} <span class="muted">/ ${fmtN(gl)}</span></span></div>${bar(g.spent, gl, g.spent > gl ? 'var(--danger)' : g.color)}</button>`; }).join('');
  const other = Object.entries(sp.byCat).filter(([c, v]) => !isLiving(c) && Math.abs(v) >= 1).sort((a, b) => b[1] - a[1]);
  // unlabeled transfer recipients (last 90 days)
  const since = isoOf(new Date(Date.now() - 90 * 864e5)); const un = {};
  for (const t of S.tx) { if (t.d < since || t.a >= 0 || payeeOf(t)) continue; if (!['Подарки и переводы', 'Прочее'].includes(t.cat)) continue; const k = payeeKey(t); if (!k) continue; un[k] = un[k] || { k, sum: 0, n: 0 }; un[k].sum -= t.a; un[k].n++; }
  const unl = Object.values(un).filter(u => u.sum >= 20000).sort((a, b) => b.sum - a.sum).slice(0, 4);
  let list = S.tx.filter(t => t.d >= r.from && t.d <= r.to);
  if (exFilter) { const g = S.limits.find(l => l.id === exFilter); list = list.filter(t => g ? g.cats.includes(t.cat) : t.cat === exFilter); }
  const shown = exAll ? list : list.slice(0, 20);
  el.innerHTML = `<section class="card">
    <div class="seg"><button type="button" data-act="ex-mode" data-m="week" aria-pressed="${exMode === 'week'}">Неделя</button><button type="button" data-act="ex-mode" data-m="month" aria-pressed="${exMode === 'month'}">Месяц</button></div>
    <div class="row-between period"><button class="btn tiny ghost" type="button" data-act="ex-prev" aria-label="Назад">‹</button><b>${label}</b><button class="btn tiny ghost" type="button" data-act="ex-next" aria-label="Вперёд" ${exOff >= 0 ? 'disabled' : ''}>›</button></div>
    <div class="big ${sp.living > lim ? 'neg' : ''}">${fmtN(sp.living)} ₽</div><div class="sub">из ${fmtN(lim)} ₽ на жизнь${sp.living <= lim ? ` · осталось ${fmtN(lim - sp.living)} ₽` : ` · перерасход ${fmtN(sp.living - lim)} ₽`}</div>
    ${bar(sp.living, lim, sp.living > lim ? 'var(--danger)' : 'var(--accent)')}
    <div class="actions"><button class="btn primary" type="button" data-act="quick-add">+ Трата</button><button class="btn" type="button" data-act="import-statements">Загрузить выписку</button></div></section>
    ${unl.length ? `<section class="card"><h2>Кто эти получатели?</h2><p class="sub">Подпишите один раз — переводы им будут попадать в нужную статью.</p>${unl.map(u => `<div class="li"><div class="grow"><b>${esc(u.k.startsWith('+7') ? '…' + u.k.slice(-4) : u.k)}</b><div class="small muted">${u.n} ${plural(u.n, ['перевод', 'перевода', 'переводов'])} за 3 месяца</div></div><div class="num"><b>${fmtN(u.sum)}</b><button class="btn tiny" type="button" data-act="label-payee" data-k="${esc(u.k)}">Подписать</button></div></div>`).join('')}</section>` : ''}
    <section class="card"><h2>По статьям</h2>${rows}
      ${other.length ? `<details class="more"><summary>Не входит в лимиты</summary>${other.map(([c, v]) => `<button type="button" class="li li-btn" data-act="ex-filter" data-id="${esc(c)}"><span class="grow">${esc(c)}</span><span class="num ${v < 0 ? 'pos' : ''}">${v < 0 ? '+' : ''}${fmtN(Math.abs(v))}</span></button>`).join('')}</details>` : ''}</section>
    <section class="card"><div class="row-between"><h2>Операции${exFilter ? ' · ' + esc((S.limits.find(l => l.id === exFilter) || {}).name || exFilter) : ''}</h2>${exFilter ? '<button class="btn tiny ghost" type="button" data-act="ex-filter" data-id="">Все</button>' : ''}</div>
      ${shown.length ? shown.map(t => { const p = payeeOf(t); return `<div class="li"><div class="date sm"><b>${+t.d.slice(8)}</b><span>${MS[+t.d.slice(5, 7) - 1]}</span></div><div class="grow"><div class="ellip">${esc(p ? p.name : t.desc)}</div><button type="button" class="chip-cat" data-act="tx-cat" data-id="${t.id}">${esc(t.cat)}</button></div><div class="num ${t.a > 0 ? 'pos' : ''}">${t.a > 0 ? '+' : '−'}${fmtN(Math.abs(t.a))}</div></div>`; }).join('') : '<p class="sub">Операций нет.</p>'}
      ${list.length > shown.length ? `<button class="btn ghost wide" type="button" data-act="ex-all">Показать все (${list.length})</button>` : ''}</section>`;
}
function quickAdd() {
  const cats = livingCats();
  openDialog(`<h3>Новая трата</h3>
    <div class="form">${field('Сумма, ₽', `<input type="text" inputmode="decimal" name="amt" required autofocus>`)}${field('Дата', `<input type="date" name="d" value="${todayISO()}">`)}</div>
    ${field('Статья', `<div class="chips" id="qcats">${cats.map((c, i) => `<button type="button" class="chip" data-c="${esc(c)}" aria-pressed="${i === 0}">${esc(c)}</button>`).join('')}</div>`)}
    ${field('Комментарий', '<input type="text" name="note" placeholder="необязательно">')}
    <p class="alert warn" id="qWarn" hidden style="margin:0"></p>
    <p class="hint" style="margin:0">Для наличных и карт, выписки которых вы не загружаете. Если позже такая же операция придёт в выписке, ручная запись заменится ею автоматически.</p>`,
    `<button class="btn ghost" value="cancel" formnovalidate>Отмена</button><button class="btn primary" value="ok">Добавить</button>`, (v, b) => {
      const a = parseNum(b.querySelector('[name=amt]').value); if (!a) { b.querySelector('[name=amt]').focus(); return false; }
      const cat = (b.querySelector('#qcats [aria-pressed="true"]') || {}).dataset.c || 'Прочее';
      const dd = b.querySelector('[name=d]').value || todayISO();
      const same = S.tx.find(t => Math.abs(t.a + Math.abs(a)) < 0.01 && dayDiff(t.d, dd) <= 1);
      if (same && !b.dataset.ok) { b.dataset.ok = '1'; const w = b.querySelector('#qWarn'); w.hidden = false; w.innerHTML = `Похоже, эта трата уже есть: <b>${esc(payeeOf(same) ? payeeOf(same).name : same.desc)}</b>, ${shortDate(same.d)}, ${fmt(Math.abs(same.a))}. Если это другая трата, нажмите «Добавить» ещё раз.`; return false; }
      S.tx.unshift({ id: uid(), d: b.querySelector('[name=d]').value || todayISO(), a: -Math.abs(a), desc: b.querySelector('[name=note]').value.trim() || cat, src: 'Вручную', cat, mc: true });
      persistNow(); renderAll(); toast('Трата добавлена');
    }, (b) => { const rs = () => { delete b.dataset.ok; b.querySelector('#qWarn').hidden = true; }; b.querySelector('[name=amt]').addEventListener('input', rs); b.querySelector('[name=d]').addEventListener('input', rs); b.querySelector('#qcats').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c) return; $$('#qcats .chip').forEach(x => x.setAttribute('aria-pressed', String(x === c))); }); });
}
function txCatDialog(id) {
  const t = S.tx.find(x => x.id === id); if (!t) return; const key = payeeKey(t);
  openDialog(`<h3>${esc(t.desc)}</h3><p class="sub" style="margin:0">${dText(t.d)} · ${t.a > 0 ? '+' : '−'}${fmt(Math.abs(t.a))} · ${esc(t.src || '')}</p>
    ${field('Статья', `<select name="cat">${allCats().map(c => `<option ${c === t.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`)}
    ${key ? '' : `<label class="check"><input type="checkbox" name="rule" checked> Запомнить для похожих операций</label>`}
    ${key ? `<p class="sub" style="margin:0">Это перевод получателю ${esc(key.startsWith('+7') ? '…' + key.slice(-4) : key)}. Чтобы все переводы ему попадали в одну статью, нажмите «Подписать получателя».</p>` : ''}
    ${t.cat === 'Платежи по кредитам' && t.a < 0 ? '<p class="sub" style="margin:0">Можно отметить это как платёж по кредиту — остаток кредита уменьшится.</p>' : ''}`,
    `${key ? `<button class="btn" value="payee" type="submit">Подписать получателя</button>` : ''}${t.cat === 'Платежи по кредитам' && t.a < 0 ? '<button class="btn" value="debtpay">Отметить платёж</button>' : ''}<button class="btn primary" value="ok">Сохранить</button>`, (v, b) => {
      if (v === 'payee') { setTimeout(() => labelPayee(key), 50); return; }
      if (v === 'debtpay') { const text = (t.desc || '').toLowerCase(); const guess = activeDebts().find(d => d.name.toLowerCase().split(/[·\s]+/).filter(w => w.length > 3).some(w => text.includes(w))) || activeDebts()[0]; setTimeout(() => payDialog(guess && guess.id, Math.abs(t.a), false, t.d), 50); return; }
      const c = b.querySelector('[name=cat]').value; t.cat = c; t.mc = true;
      const rule = b.querySelector('[name=rule]');
      if (rule && rule.checked) { const k = t.desc.toLowerCase().replace(/\d{3,}/g, '').replace(/\s+/g, ' ').trim().slice(0, 40); if (k.length >= 4) { S.rules = S.rules.filter(r => r.k !== k); S.rules.unshift({ k, c }); recategorizeAll(); } }
      persistNow(); renderAll(); toast('Сохранено');
    });
}
function labelPayee(key) {
  const ex = S.payees.find(p => p.match === key) || {};
  const cats = allCats().filter(c => !['Поступления'].includes(c));
  openDialog(`<h3>Получатель ${esc(key.startsWith('+7') ? '…' + key.slice(-4) : key)}</h3>
    ${field('Как подписать', `<input type="text" name="name" value="${esc(ex.name || '')}" placeholder="например, Аренда" required>`)}
    ${field('Статья', `<select name="cat">${cats.map(c => `<option ${c === (ex.cat || 'Подарки и переводы') ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__new">Новая статья — как подпись</option></select>`, 'Статьи вне лимитов (аренда, свои переводы, платежи по кредитам) не считаются тратами на жизнь.')}`,
    `<button class="btn ghost" value="cancel" formnovalidate>Отмена</button><button class="btn primary" value="ok">Сохранить</button>`, (v, b) => {
      const name = b.querySelector('[name=name]').value.trim(); if (!name) return false;
      let cat = b.querySelector('[name=cat]').value; if (cat === '__new') cat = name;
      S.payees = S.payees.filter(p => p.match !== key); S.payees.push({ match: key, name, cat });
      for (const t of S.tx) if (t.mc && (t.desc || '').includes(key)) delete t.mc;
      recategorizeAll(); persistNow(); renderAll(); toast('Получатель подписан');
    });
}

// ---------- view: Payments ----------
let payMode = 'list', payOpenM = null;
function viewPayments() {
  const el = $('#v-payments');
  const seg = `<div class="seg"><button type="button" data-act="pay-mode" data-m="list" aria-pressed="${payMode === 'list'}">Список</button><button type="button" data-act="pay-mode" data-m="days" aria-pressed="${payMode === 'days'}">По дням</button></div>`;
  if (!activeDebts().length) { el.innerHTML = `<section class="card empty"><p>Кредитов пока нет.</p><button class="btn primary" type="button" data-act="add-debt">Добавить кредит</button></section>`; return; }
  const cm = curMonth(); const r = F.months[0]; const facts = factsByMonth()[cm] || {};
  let top = '';
  if (payMode === 'days') {
    const c = calendarFor(calK);
    const chips = [0, 1, 2].map(k => `<button type="button" class="chip" data-act="cal-k" data-k="${k}" aria-pressed="${k === calK}">${MN[ENG.parseM(ENG.addM(cm, k)).m - 1]}</button>`).join('');
    const w = payWindows(); const sched = ENG.incomeSchedule(S, cm, 1).rows[0];
    const rec = calK === 0 && w.heavy.length && w.advSum > 0.6 * (sched.adv || 1) ? `<details class="alert warn"><summary>Аванс перегружен: из него уходит ${fmtN(w.advSum)} ₽ платежей</summary><div>Эти платежи удобнее вносить из зарплаты, около ${(+S.salary.salDay || 10) + 5}-го:${w.heavy.slice(0, 4).map(h => `<div class="row-between" style="margin-top:6px"><span>${esc(h.d.name)}, срок ${h.d.dueDay}-го</span><button class="btn tiny" type="button" data-act="set-payday" data-id="${h.d.id}" data-day="${(+S.salary.salDay || 10) + 5}">Платить ${(+S.salary.salDay || 10) + 5}-го</button></div>`).join('')}</div></details>` : '';
    top = `<section class="card"><div class="row-between"><h2>${mName(c.cm)}</h2><div class="chips">${chips}</div></div>${rec}
      <div class="row-between small muted" style="padding:6px 0">На начало месяца <b class="num">${fmtN(c.start)}</b></div>
      ${c.byDay.filter(x => x.its.length).map(x => `<div class="li${x.bal < 0 ? ' negrow' : ''}"><div class="date sm"><b>${x.d}</b><span>${WD[new Date(ENG.parseM(c.cm).y, ENG.parseM(c.cm).m - 1, x.d).getDay()]}</span></div><div class="grow">${x.its.map(i => `<div class="row-between small"><span class="ellip">${i.debt ? `<span class="dot" style="background:${debtColor(i.debt)}"></span>` : ''}${esc(i.name)}${i.kind === 'paid' ? ' ✓' : ''}</span><span class="num ${i.kind === 'in' ? 'pos' : ''}">${i.kind === 'in' ? '+' : '−'}${fmtN(i.amt)}</span></div>`).join('')}</div><div class="num small ${x.bal < 0 ? 'neg' : 'muted'}" style="min-width:64px">${fmtN(x.bal)}</div></div>`).join('')}
      <p class="hint">Справа — остаток на счёте после дня с учётом трат ≈ ${fmtN(c.living)} ₽ в день.</p></section>`;
  } else {
    const ids = new Set([...Object.keys(r.pay).filter(k => r.pay[k] > 0.5), ...Object.keys(facts)]);
    const items = [...ids].map(id => ({ id, d: debtById(id) || { name: debtName(id), color: '#888', dueDay: 28 }, rem: r.pay[id] || 0, ex: r.extraPay[id] || 0, paid: facts[id] || 0 })).sort((a, b) => (+(a.d.payDay || a.d.dueDay) || 28) - (+(b.d.payDay || b.d.dueDay) || 28));
    top = `<section class="card"><h2>Платежи в ${mPrep(cm)}</h2>${items.map(i => { const done = i.rem < 1 && i.paid > 0; return `<div class="li${done ? ' done' : ''}"><div class="date"><b>${Math.min(+(i.d.payDay || i.d.dueDay) || 28, dim(cm))}</b><span>${MS[ENG.parseM(cm).m - 1]}</span></div><div class="grow"><div class="clamp2"><span class="dot" style="background:${i.d.color}"></span>${esc(i.d.name)}</div><div class="small muted">${i.paid ? `оплачено ${fmtN(i.paid)}` : ''}${i.ex > 0.5 ? `${i.paid ? ' · ' : ''}<span class="pos">досрочно ${fmtN(i.ex)}</span>` : ''}</div></div><div class="num">${done ? '<b class="pos">✓</b>' : `<b>${fmtN(i.rem)}</b><button class="btn tiny" type="button" data-act="pay" data-id="${i.id}" data-amount="${Math.round(i.rem)}" data-extra="${i.ex > 0.5 ? 1 : 0}">Оплачено</button>`}</div></div>`; }).join('')}
      <button class="btn ghost wide" type="button" data-act="pay">Внести другой платёж</button></section>`;
  }
  const act = activeDebts(), closed = S.debts.filter(d => d.status === 'closed');
  const debts = `<section class="card"><div class="row-between"><h2>Кредиты</h2><button class="btn tiny" type="button" data-act="add-debt">+ Добавить</button></div>
    ${act.map(d => { const due = Math.min(+(d.payDay || d.dueDay) || 28, dim(cm)); const nextAmt = (r.pay[d.id] || 0); return `<button type="button" class="li li-btn" data-act="debt-open" data-id="${d.id}"><span class="dot big-dot" style="background:${d.color}"></span><span class="grow"><span class="clamp2">${esc(d.name)}</span><span class="small muted">${fmtN0(d.rate || 0)}% · ${nextAmt > 0.5 ? `${due}-го ${fmtN(nextAmt)} ₽` : 'в этом месяце без платежа'}${F.payoffBy[d.id] ? ` · до ${mShort(F.payoffBy[d.id])}` : ''}</span></span><span class="num"><b>${fmtN(d.balance)}</b></span></button>`; }).join('')}
    ${closed.length ? `<details class="more"><summary>Закрытые (${closed.length})</summary>${closed.map(d => `<div class="li"><span class="grow muted">${esc(d.name)}</span><button class="btn tiny" type="button" data-act="reopen-debt" data-id="${d.id}">Вернуть</button><button class="btn tiny ghost danger" type="button" data-act="del-debt" data-id="${d.id}">Удалить</button></div>`).join('')}</details>` : ''}</section>`;
  const months = `<section class="card"><h2>По месяцам</h2>${F.months.slice(0, 24).map(m => { const tot = m.minTotal + m.extraTotal; const open = payOpenM === m.m; return `<button type="button" class="li li-btn" data-act="pay-month" data-m="${m.m}"><span class="grow"><span>${mName(m.m)}</span><span class="small muted">долг на конец ${fmtC(m.totalBal)}</span></span><span class="num"><b>${fmtN(tot)}</b>${m.extraTotal > 0.5 ? `<span class="small pos">досрочно ${fmtN(m.extraTotal)}</span>` : ''}</span></button>${open ? `<div class="sublist">${Object.entries(m.pay).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).map(([id, v]) => `<div class="row-between small"><span class="ellip"><span class="dot" style="background:${debtColor(id)}"></span>${esc(debtName(id))}</span><span class="num ${(m.extraPay[id] || 0) > 0.5 ? 'pos' : ''}">${fmtN(v)}</span></div>`).join('')}</div>` : ''}`; }).join('')}</section>`;
  el.innerHTML = seg + top + debts + months;
}
function debtOpen(id) {
  const d = debtById(id); if (!d) return;
  const ps = S.payments.filter(p => p.debtId === id).sort((a, b) => a.date < b.date ? 1 : -1);
  openDialog(`<h3><span class="dot" style="background:${d.color}"></span>${esc(d.name)}</h3>
    <div class="kv"><div><span class="label">Остаток</span><b>${fmt(d.balance)}</b></div><div><span class="label">Ставка</span><b>${fmtN0(d.rate || 0)}%</b></div><div><span class="label">Платёж</span><b>${esc(payRule(d))}</b></div><div><span class="label">Срок платежа</span><b>${d.dueDay || '—'}-го${d.payDay && +d.payDay !== +d.dueDay ? `, плачу ${d.payDay}-го` : ''}</b></div><div><span class="label">Закроется</span><b>${F.payoffBy[id] ? mName(F.payoffBy[id]) : '—'}</b></div><div><span class="label">Остаток на дату</span><b>${dText(d.balanceDate)}</b></div></div>
    ${d.note ? `<p class="sub" style="margin:0">${esc(d.note)}</p>` : ''}
    <div><b>Платежи</b>${ps.length ? ps.map(p => `<div class="li"><span class="grow small">${dText(p.date)}${p.extra ? ' · досрочно' : ''}</span><span class="num small">${fmtN(p.amount)}</span><button class="btn tiny ghost danger" type="button" data-act="del-pay" data-id="${p.id}">✕</button></div>`).join('') : '<p class="sub" style="margin:4px 0 0">Пока нет.</p>'}</div>`,
    `<button class="btn" value="edit">Изменить</button><button class="btn primary" value="pay">Внести платёж</button><button class="btn ghost small-btn" value="close-debt">Кредит погашен — убрать из плана</button>`, (v) => {
      setTimeout(() => {
        if (v === 'pay') payDialog(id, '', false);
        if (v === 'edit') debtDialog(d);
        if (v === 'close-debt') openDialog(`<h3>«${esc(d.name)}» погашен?</h3><p class="sub" style="margin:0">Используйте это, когда кредит полностью выплачен или договор закрыт в банке. Он уйдёт в «Закрытые» и перестанет участвовать в плане.${+d.balance > 0 ? ` Сейчас по нему ещё числится ${fmt(d.balance)} — если это ошибка, лучше внесите платёж или поправьте остаток через «Изменить».` : ''} Вернуть можно в любой момент.</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Да, убрать из плана</button>`, () => { d.status = 'closed'; d.closedAt = todayISO(); recordHistory(); persistNow(); renderAll(); toast('Кредит закрыт'); });
      }, 50);
    });
}

// ---------- view: More (Budget, Salary, Settings) ----------
let moreView = null;
function viewMore() {
  const el = $('#v-more');
  if (!moreView) {
    el.innerHTML = `<section class="card">${[['budget', 'Бюджет', 'Лимиты по статьям, постоянные и разовые расходы'], ['salary', 'Зарплата', 'Расчётки, прогноз дохода'], ['settings', 'Настройки', 'Синхронизация, копия данных, деньги на счетах']].map(([k, t, s]) => `<button type="button" class="li li-btn" data-act="more" data-v="${k}"><span class="grow"><b>${t}</b><span class="small muted">${s}</span></span><span class="chev">›</span></button>`).join('')}</section>`;
    return;
  }
  const back = `<button class="btn tiny ghost back" type="button" data-act="more" data-v="">‹ Назад</button>`;
  if (moreView === 'budget') el.innerHTML = back + budgetHTML();
  if (moreView === 'salary') { el.innerHTML = back + salaryHTML(); bindSalaryChart(); }
  if (moreView === 'settings') el.innerHTML = back + settingsHTML();
}
function monthOptions(sel) {
  const out = []; for (let k = -6; k <= 24; k++) { const m = ENG.addM(curMonth(), k); out.push(`<option value="${m}" ${m === sel ? 'selected' : ''}>${MS[ENG.parseM(m).m - 1]} ${ENG.parseM(m).y}</option>`); }
  if (sel && !out.some(o => o.includes(`"${sel}"`))) out.unshift(`<option value="${sel}" selected>${MS[ENG.parseM(sel).m - 1]} ${ENG.parseM(sel).y}</option>`);
  return out.join('');
}
function budgetHTML() {
  const total = S.limits.reduce((a, l) => a + (+l.month || 0), 0);
  return `<section class="card"><div class="row-between"><h2>Лимиты на жизнь</h2><span class="label">${fmtN(total)} ₽ в месяц · ${fmtN(total * weekShare)} ₽ в неделю</span></div>
    ${S.limits.map((l, i) => `<div class="li"><span class="dot" style="background:${LIMIT_COLORS[i % LIMIT_COLORS.length]}"></span><span class="grow">${esc(l.name)}<span class="small muted">${fmtN(l.month * weekShare)} ₽ в неделю</span></span><input class="num-in" type="text" inputmode="decimal" data-lim="${l.id}" value="${esc(fmtN0(l.month))}"></div>`).join('')}
    <p class="hint">Сумма лимитов — это «расходы на жизнь» в плане погашения.</p></section>
    <section class="card"><div class="row-between"><h2>Постоянные расходы</h2><button class="btn tiny" type="button" data-act="add-fixed">+ Добавить</button></div>
    ${S.fixed.map(f => `<div class="fx-row" data-fixed="${f.id}"><input type="text" data-f="name" value="${esc(f.name)}" class="grow-in"><input class="num-in" type="text" inputmode="decimal" data-f="amount" value="${esc(fmtN0(f.amount))}"><input class="day-in" type="number" min="1" max="31" data-f="day" value="${esc(f.day || 1)}" aria-label="число"><button class="btn tiny ghost danger" type="button" data-act="del-fixed" data-id="${f.id}">✕</button></div>`).join('')}
    <p class="hint">Сумма и число месяца, когда списывается.</p></section>
    <section class="card"><div class="row-between"><h2>Разовые траты и поступления</h2><button class="btn tiny" type="button" data-act="add-ev">+ Добавить</button></div>
    ${S.events.slice().sort((a, b) => (a.month + String(a.day || 1).padStart(2, '0')) < (b.month + String(b.day || 1).padStart(2, '0')) ? -1 : 1).map(e => `<div class="ev" data-ev="${e.id}"><input type="text" data-e="note" value="${esc(e.note || '')}" placeholder="Что это" class="grow-in"><div class="ev-row"><select data-e="month" class="mon-in">${monthOptions(e.month)}</select><input class="day-in" type="number" min="1" max="31" data-e="day" value="${esc(e.day || 1)}" aria-label="число"><input class="num-in" type="text" inputmode="decimal" data-e="amount" value="${esc(fmtN0(e.amount))}"><button class="btn tiny ghost danger" type="button" data-act="del-ev" data-id="${e.id}">✕</button></div></div>`).join('') || '<p class="sub">Нет.</p>'}
    <p class="hint">Траты — со знаком минус, поступления (например, налоговый вычет) — с плюсом.</p></section>`;
}
const SAL_PARTS2 = [['sal', 'Оклад с северными', '#3B5BA5'], ['hou', 'Жильё', '#2A8FB8'], ['trip', 'Командировки', '#8C6A43'], ['vac', 'Отпускные', '#7A4FA0'], ['sick', 'Больничный', '#C0563A'], ['bon', 'Премии', '#0F7A62'], ['oth', 'Прочее', '#6B8E23']];
let salChart = null;
function salaryHTML() {
  const P = S.payroll.slice().sort((a, b) => a.m < b.m ? -1 : 1).slice(-18);
  const sm = S.salary;
  let chart = '';
  if (P.length) {
    const W = 640, H = 240, pl = 6, pr = 6, pt = 10, pb = 30; const N = P.length;
    const maxV = Math.max(...P.map(r => Object.values(r.p).reduce((a, v) => a + Math.max(0, v), 0))) * 1.05;
    const bw = (W - pl - pr) / N, ys = (v) => pt + (H - pt - pb) * (1 - v / maxV);
    let g = '';
    P.forEach((r, i) => { let y0 = 0; const x = pl + i * bw + bw * .15, w = bw * .7; for (const [k, , c] of SAL_PARTS2) { const v = Math.max(0, r.p[k] || 0); if (!v) continue; g += `<rect x="${x.toFixed(1)}" y="${ys(y0 + v).toFixed(1)}" width="${w.toFixed(1)}" height="${(ys(y0) - ys(y0 + v)).toFixed(1)}" fill="${c}" fill-opacity="${r.partial ? '.35' : '.85'}" rx="2"/>`; y0 += v; } if (i % Math.ceil(N / 6) === 0) g += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 6}" font-size="20" fill="var(--ink-3)" text-anchor="middle">${mShort(r.m)}</text>`; });
    let line = ''; P.forEach((r, i) => line += (i ? 'L' : 'M') + (pl + i * bw + bw / 2).toFixed(1) + ',' + ys(r.net).toFixed(1));
    g += `<path d="${line}" fill="none" stroke="var(--ink)" stroke-width="2"/>`;
    salChart = { P, W, H, pl, bw, maxV, ys };
    chart = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" class="mini-chart" id="salSvg">${g}</svg><div class="tip" id="salTip"></div></div><p class="hint">Столбцы — начислено, линия — на руки. Нажмите на месяц, чтобы увидеть детали.</p>`;
  }
  const sch = ENG.incomeSchedule(S, curMonth(), 12).rows;
  const num = (path, val, label, help) => field(label, `<input type="text" inputmode="decimal" data-path="${path}" value="${esc(fmtN0(val))}">`, help);
  const monthSel = (path, val) => `<select data-path="${path}">${MN.map((m, i) => `<option value="${i + 1}" ${+val === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
  return `<section class="card"><div class="row-between"><h2>Зарплата</h2><button class="btn tiny primary" type="button" data-act="upload-payslip">Загрузить расчётку</button></div>${chart || '<p class="sub">Расчёток пока нет.</p>'}</section>
    <section class="card"><h2>Сколько придёт</h2><p class="hint" style="margin-top:0">Расчёт до ${sm.salDay}-го и аванс до ${sm.advDay}-го. ★ — с премией.</p>
      ${sch.map(r => `<div class="row-between li"><span>${mName(r.m)}</span><span class="amt"><b>${fmtN(r.salary + r.bonus)}</b>${r.bonus > 0.5 ? ' <span class="pos">★</span>' : ''}</span></div>`).join('')}</section>
    <details class="card more"><summary>Параметры расчёта</summary><div class="form" style="margin-top:12px">
      ${num('salary.oklad', sm.oklad, 'Оклад до налога, ₽')}${num('salary.rk', sm.rk, 'Районный коэффициент, %')}${num('salary.sn', sm.sn, 'Северная надбавка, %')}${num('salary.housing', sm.housing, 'Доплата за жильё, ₽')}
      <label class="check"><input type="checkbox" data-path="salary.housingOn" ${sm.housingOn !== false ? 'checked' : ''}> Доплата за жильё начисляется</label>
      ${num('salary.salDay', sm.salDay, 'Расчёт приходит до, число')}${num('salary.advDay', sm.advDay, 'Аванс приходит до, число')}${num('salary.advPct', sm.advPct, 'Аванс, % от месячной суммы')}
      ${num('salary.qPct', sm.qPct, 'Квартальная премия, % от оклада за квартал')}
      <div class="field"><span class="flabel">Месяцы квартальной премии</span><div class="chips">${MS.map((m, i) => `<button type="button" class="chip" data-act="qmonth" data-m="${i + 1}" aria-pressed="${(sm.qMonths || []).includes(i + 1)}">${m}</button>`).join('')}</div></div>
      ${field('Годовая премия, первая выплата', monthSel('salary.y1Month', sm.y1Month))}${num('salary.y1Mult', sm.y1Mult, 'Размер, окладов')}
      ${field('Годовая премия, вторая выплата', monthSel('salary.y2Month', sm.y2Month))}${num('salary.y2Mult', sm.y2Mult, 'Размер, окладов')}
      ${field('Индексация оклада, месяц', monthSel('salary.indexMonth', sm.indexMonth))}${num('salary.indexPct', sm.indexPct, 'Индексация, %')}
    </div></details>`;
}
function bindSalaryChart() {
  const svg = $('#salSvg'), tip = $('#salTip'); if (!svg || !salChart) return;
  const { P, W, pl, bw } = salChart;
  const show = (ev) => { const rect = svg.getBoundingClientRect(); const x = (ev.clientX - rect.left) / rect.width * W; const i = Math.max(0, Math.min(P.length - 1, Math.floor((x - pl) / bw))); const r = P[i];
    tip.innerHTML = `<b>${mName(r.m)}</b>${r.partial ? ' (неполная)' : ''}<br>Начислено ${fmt(r.acc)}<br>НДФЛ ${fmt(r.ndfl)}<br><b>На руки ${fmt(r.net)}</b>`; tip.style.display = 'block'; tip.style.left = Math.max(90, Math.min(rect.width - 90, (pl + i * bw + bw / 2) / W * rect.width)) + 'px'; tip.style.top = '8px'; };
  svg.addEventListener('pointerdown', show); svg.addEventListener('pointermove', show); svg.addEventListener('pointerleave', () => tip.style.display = 'none');
}
function settingsHTML() {
  const s = S.settings;
  return `<section class="card"><h2>Деньги</h2><div class="form">
      ${field('Свободные деньги на начало месяца, ₽', `<input type="text" inputmode="decimal" data-path="settings.cashNow" value="${esc(fmtN0(s.cashNow))}">`, 'Сколько лежит на счетах сверх текущих трат. Нужно для календаря.')}
      ${field('Подушка на счёте, ₽', `<input type="text" inputmode="decimal" data-path="settings.buffer" value="${esc(fmtN0(s.buffer))}">`, 'Эта сумма всегда остаётся на счёте.')}</div></section>
    <section class="card"><h2>Синхронизация</h2><p class="sub">${cloudConfigured ? (session ? `Вход: ${esc(session.user.email)}. Данные шифруются на устройстве и только потом уходят в облако.` : localOnly ? 'Без входа: данные только в этом браузере.' : '') : 'Облако не настроено — данные только в этом браузере.'}</p><div class="sync" data-sync="full"></div>
      <div class="actions">${cloudConfigured && session ? '<button class="btn" type="button" data-act="signout">Выйти</button><button class="btn ghost danger" type="button" data-act="signout-clear">Выйти и стереть с устройства</button>' : ''}${cloudConfigured && localOnly ? '<button class="btn primary" type="button" data-act="go-cloud">Войти</button>' : ''}</div></section>
    <section class="card"><h2>Данные</h2><div class="actions"><button class="btn" type="button" data-act="export">Скачать копию</button><button class="btn" type="button" data-act="import">Загрузить копию или обновление</button></div>
      <div class="actions"><button class="btn ghost" type="button" data-act="fix-plan">Начать план заново</button></div>
      <p class="hint">«Начать план заново» — текущий прогноз станет точкой отсчёта для «опережаете/отстаёте».</p></section>`;
}

// ---------- render & navigation ----------
const VIEWS = { today: viewToday, expenses: viewExpenses, payments: viewPayments, more: viewMore };
let view = localStorage.getItem('debtplan.view') || 'today'; if (!VIEWS[view]) view = 'today';
function renderAll() {
  if (activeDebts().length) { pickStrategy(); if (!S.baseline) { makeBaseline(); persist(); } }
  else F = { months: [], payoffBy: {}, deadlineMiss: [], deficitMonths: [], debts: [], totalInterest: 0 };
  try { VIEWS[view](); } catch (e) { console.error(e); $('#v-' + view).innerHTML = `<section class="card empty">Не удалось показать раздел: ${esc(e.message)}</section>`; }
  $$('[data-nav]').forEach(b => b.setAttribute('aria-current', String(b.dataset.nav === view)));
  $$('main > section.view').forEach(s => s.hidden = s.id !== 'v-' + view);
  renderSync();
}
function go(v) { view = v; localStorage.setItem('debtplan.view', v); if (v !== 'more') moreView = moreView; renderAll(); window.scrollTo(0, 0); }
document.addEventListener('click', (e) => { const n = e.target.closest('[data-nav]'); if (n) { if (n.dataset.nav === 'more' && view === 'more') moreView = null; go(n.dataset.nav); } });

// ---------- patch import (merge, not replace) ----------
function applyPatch(o) {
  if (Array.isArray(o.payees)) for (const p of o.payees) { S.payees = S.payees.filter(x => x.match !== p.match); S.payees.push(p); }
  if (Array.isArray(o.rules)) for (const r of o.rules.slice().reverse()) { S.rules = S.rules.filter(x => x.k !== r.k); S.rules.unshift(r); }
  if (Array.isArray(o.ownContracts)) for (const c of o.ownContracts) if (!S.ownContracts.includes(c)) S.ownContracts.push(c);
  if (Array.isArray(o.fixedAdd)) for (const f of o.fixedAdd) { const ex = S.fixed.find(x => x.name === f.name); if (ex) Object.assign(ex, f); else S.fixed.push({ id: uid(), ...f }); }
  if (Array.isArray(o.limits) && o.limits.length) S.limits = o.limits;
  if (Array.isArray(o.debtsAdd)) for (const d of o.debtsAdd) { if (S.debts.some(x => x.id === d.id || x.name === d.name)) continue; S.debts.push(Object.assign({ color: PAL[S.debts.length % PAL.length], status: 'active' }, d)); }
  if (Array.isArray(o.debtsUpdate)) for (const u of o.debtsUpdate) { const d = S.debts.find(x => x.id === u.id); if (d) Object.assign(d, u.set || {}); }
  if (Array.isArray(o.paymentsAdd)) for (const p of o.paymentsAdd) {
    const d = debtById(p.debtId); if (!d) continue;
    if (S.payments.some(x => x.debtId === p.debtId && Math.abs(x.amount - p.amount) < 1 && Math.abs(new Date(x.date) - new Date(p.date)) <= 3 * 864e5)) continue;
    S.payments.push(Object.assign({ id: uid() }, p));
    d.balance = Math.max(0, Math.round(((+d.balance || 0) - (+p.principal || 0)) * 100) / 100); d.balanceDate = p.date;
  }
  recordHistory();
  if (o.settings) Object.assign(S.settings, o.settings);
  S.settings.living = S.limits.reduce((a, l) => a + (+l.month || 0), 0);
  recategorizeAll();
  if (o.resetBaseline) { pickStrategy(); makeBaseline(); }
}

// ---------- events ----------
function setPath(path, value) { const [a, b] = path.split('.'); S[a][b] = value; }
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  switch (act) {
    case 'quick-add': quickAdd(); break;
    case 'chart-hi': chartHi = chartHi === id ? null : id; rerenderChart(); break;
    case 'chart-step': chartStep = b.dataset.s; localStorage.setItem('debtplan.chartStep', chartStep); chartSel = null; rerenderChart(); break;
    case 'chart-now': chartSel = null; rerenderChart(); break;
    case 'import-statements': importStatements(); break;
    case 'ex-mode': exMode = b.dataset.m; exOff = 0; exAll = false; viewExpenses(); break;
    case 'ex-prev': exOff--; exAll = false; viewExpenses(); break;
    case 'ex-next': if (exOff < 0) exOff++; exAll = false; viewExpenses(); break;
    case 'ex-filter': exFilter = id && exFilter !== id ? id : null; exAll = false; viewExpenses(); break;
    case 'ex-all': exAll = true; viewExpenses(); break;
    case 'tx-cat': txCatDialog(id); break;
    case 'label-payee': labelPayee(b.dataset.k); break;
    case 'pay-mode': payMode = b.dataset.m; viewPayments(); break;
    case 'pay-month': payOpenM = payOpenM === b.dataset.m ? null : b.dataset.m; viewPayments(); break;
    case 'cal-k': calK = +b.dataset.k; viewPayments(); break;
    case 'debt-open': debtOpen(id); break;
    case 'more': moreView = b.dataset.v || null; viewMore(); window.scrollTo(0, 0); break;
    case 'add-debt': debtDialog(null); break;
    case 'pay': payDialog(id, b.dataset.amount ? +b.dataset.amount : '', b.dataset.extra === '1'); break;
    case 'reopen-debt': { const d = debtById(id); d.status = 'active'; delete d.closedAt; recordHistory(); persistNow(); renderAll(); break; }
    case 'del-debt': { const d = debtById(id); openDialog(`<h3>Удалить «${esc(d.name)}» насовсем?</h3>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Удалить</button>`, () => { S.debts = S.debts.filter(x => x.id !== id); persistNow(); renderAll(); }); break; }
    case 'del-pay': {
      const p = S.payments.find(x => x.id === id); if (!p) break; dlg.close();
      setTimeout(() => openDialog(`<h3>Удалить платёж ${fmt(p.amount)} от ${dText(p.date)}?</h3><p class="sub" style="margin:0">${fmt(p.principal)} вернутся в остаток кредита.</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Удалить</button>`, () => {
        S.payments = S.payments.filter(x => x.id !== id); const d = debtById(p.debtId);
        if (d) { d.balance = Math.round(((+d.balance || 0) + (+p.principal || 0)) * 100) / 100; if (d.status === 'closed' && d.balance > 0) { d.status = 'active'; delete d.closedAt; } }
        recordHistory(); persistNow(); renderAll(); toast('Платёж удалён');
      }), 50);
      break;
    }
    case 'set-payday': { const d = debtById(id); d.payDay = +b.dataset.day; persistNow(); renderAll(); toast(`«${d.name}»: платить ${d.payDay}-го`); break; }
    case 'qmonth': { const m = +b.dataset.m; const q = S.salary.qMonths || []; S.salary.qMonths = q.includes(m) ? q.filter(x => x !== m) : q.concat(m).sort((a, c) => a - c); persistNow(); renderAll(); break; }
    case 'add-fixed': S.fixed.push({ id: uid(), name: 'Новый расход', amount: 0, day: 1 }); persistNow(); renderAll(); break;
    case 'del-fixed': S.fixed = S.fixed.filter(x => x.id !== id); persistNow(); renderAll(); break;
    case 'add-ev': S.events.push({ id: uid(), month: ENG.addM(curMonth(), 1), day: 15, amount: 0, note: '' }); persistNow(); renderAll(); break;
    case 'del-ev': S.events = S.events.filter(x => x.id !== id); persistNow(); renderAll(); break;
    case 'upload-payslip': uploadPayslips(); break;
    case 'fix-plan': openDialog(`<h3>Начать план заново?</h3><p class="sub" style="margin:0">Текущий прогноз станет точкой отсчёта для «опережаете/отстаёте от плана».</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Начать заново</button>`, () => { makeBaseline(); persistNow(); renderAll(); toast('План обновлён'); }); break;
    case 'export': {
      const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `moi-finansy-${todayISO()}.json`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('Копия скачана'); break;
    }
    case 'import': {
      const files = await pickFiles('.json,application/json', false); if (!files.length) break;
      let o; try { o = JSON.parse(new TextDecoder().decode(await readBuf(files[0]))); } catch (x) { toast('Не удалось прочитать файл'); break; }
      if (o && o.patch) { openDialog(`<h3>Применить обновление?</h3><p class="sub" style="margin:0">${esc(o.title || 'Настройки будут добавлены к вашим данным. Кредиты, платежи и операции не изменятся.')}</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Применить</button>`, () => { applyPatch(o); persistNow(); renderAll(); toast('Обновление применено'); }); break; }
      if (!o || !Array.isArray(o.debts)) { toast('Это не файл копии этого приложения'); break; }
      openDialog(`<h3>Заменить все данные?</h3><p class="sub" style="margin:0">Данные на этом устройстве${session ? ' и в облаке' : ''} заменятся данными из файла.</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Заменить</button>`, () => { S = normalize(o); recordHistory(); persistNow(); renderAll(); toast('Данные загружены'); });
      break;
    }
    case 'signout': signOut(false); break;
    case 'signout-clear': openDialog(`<h3>Выйти и стереть данные с устройства?</h3><p class="sub" style="margin:0">В облаке они останутся.</p>`, `<button class="btn ghost" value="cancel">Отмена</button><button class="btn primary" value="ok">Выйти и стереть</button>`, () => signOut(true)); break;
    case 'go-cloud': localOnly = false; localStorage.removeItem('debtplan.localOnly'); initSync(); break;
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.path && t.type !== 'checkbox' && t.tagName !== 'SELECT') { setPath(t.dataset.path, parseNum(t.value)); persist(); }
  else if (t.dataset.lim) { const l = S.limits.find(x => x.id === t.dataset.lim); l.month = parseNum(t.value); S.settings.living = S.limits.reduce((a, x) => a + (+x.month || 0), 0); persist(); }
  else if (t.dataset.f) { const f = S.fixed.find(x => x.id === t.closest('[data-fixed]').dataset.fixed); f[t.dataset.f] = t.dataset.f === 'name' ? t.value : parseNum(t.value); persist(); }
  else if (t.dataset.e) { const ev = S.events.find(x => x.id === t.closest('[data-ev]').dataset.ev); const k = t.dataset.e; ev[k] = k === 'amount' || k === 'day' ? parseNum(t.value) : t.value; persist(); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.path && (t.type === 'checkbox' || t.tagName === 'SELECT')) { setPath(t.dataset.path, t.type === 'checkbox' ? t.checked : +t.value); persistNow(); renderAll(); }
  else if (t.dataset.path || t.dataset.lim || t.dataset.f || t.dataset.e) { persistNow(); renderAll(); }
});
function rerenderChart() { const b = $('.dc-body'); if (!b) return viewToday(); const y = window.scrollY; b.innerHTML = debtChartHTML(); window.scrollTo(0, y); bindDebtChart(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderAll(); });
let rz = null; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (view === 'today') viewToday(); }, 250); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
renderAll();
initSync();
})();
