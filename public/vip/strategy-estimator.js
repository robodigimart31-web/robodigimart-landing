(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const FAMILIES = ['ML', 'RL', 'SHL', 'LGL'];
  const LOTS = ['0.01', '0.02', '0.03', '0.05', '0.10', '0.20', '0.30', '0.50', '1.00', '2.00', '3.00', '5.00'];
  const PRESETS = { SAFE: ['ML', 'RL'], MEDIUM: ['ML', 'RL', 'SHL'], AGGRESSIVE: [...FAMILIES] };
  const COMBINATIONS = Array.from({ length: 16 }, (_, mask) => FAMILIES.filter((_, index) => mask & (1 << index))).filter(value => value.length);
  const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const PIPS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const DAY_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
  const sb = supabase.createClient('https://wouwoefzghecuiknznvs.supabase.co', 'sb_publishable_FDLLBcmYFGiS9PDbyvgDtQ_UWUB8fUc');
  let session = null;
  let currentData = null;
  let requestSequence = 0;
  let tablePage = 1;
  let sortDescending = false;
  let chartActiveIndex = 0;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const money = value => Number.isFinite(value) ? USD.format(value) : '—';
  const whole = value => Number.isFinite(value) ? NUMBER.format(value) : '—';
  const signedMoney = value => Number.isFinite(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${USD.format(Math.abs(value))}` : '—';
  const familiesKey = families => families.join('+');
  const comboLabel = families => families.join(' + ');
  const statusClass = status => status === 'NEGATIVE' ? 'negative' : status === 'NO TRADE' ? 'no-trade' : status === 'FLAT' ? 'flat' : '';
  const dateObject = iso => new Date(`${iso}T00:00:00Z`);

  function showGate(id) {
    for (const node of [$('#strategy-gate'), $('#strategy-login'), $('#strategy-denied'), $('#strategy-error'), $('#strategy-app')]) node.hidden = node.id !== id;
  }

  function renderFamilyOptions() {
    $('#strategy-lot').innerHTML = LOTS.map(lot => `<option value="${lot}">${lot}</option>`).join('');
    $('#strategy-families').innerHTML = COMBINATIONS.map(families => {
      const name = familiesKey(families);
      const label = families.length === 4 ? `${name} · ALL` : comboLabel(families);
      return `<option value="${name}">${escapeHtml(label)}</option>`;
    }).join('');
    $('#strategy-lot').value = '0.01';
    $('#strategy-families').value = 'ML+RL+SHL+LGL';
  }

  async function requestEstimator() {
    const sequence = ++requestSequence;
    const lot = $('#strategy-lot').value;
    const families = $('#strategy-families').value.split('+');
    const url = new URL('/vip/api/member/strategy-estimator', location.origin);
    url.searchParams.set('lot', lot);
    url.searchParams.set('families', families.join(','));
    $('#strategy-notice').textContent = 'Memperbarui hasil berdasarkan workbook…';
    try {
      const result = await fetch(url, { headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json' }, cache: 'no-store' });
      const body = await result.json();
      if (!result.ok) throw new Error(body.message || body.error || `Permintaan gagal (${result.status}).`);
      if (sequence !== requestSequence) return;
      currentData = body;
      tablePage = 1;
      $('#strategy-active-combo').textContent = `Kombinasi aktif: ${comboLabel(body.families)} · Lot ${body.lot}`;
      $('#strategy-chart-family').textContent = body.combination === 'ALL' ? 'ALL' : body.combination;
      $('#strategy-notice').textContent = `Mode ${$('#strategy-profile').selectedOptions[0].textContent} · statistik historis terkalibrasi dari eksekusi family-tagged.`;
      renderResults();
    } catch (error) {
      if (sequence !== requestSequence) return;
      $('#strategy-notice').textContent = '';
      $('#strategy-error-copy').textContent = error.message || 'Permintaan belum berhasil. Periksa koneksi lalu coba lagi.';
      showGate('strategy-error');
    }
  }

  function renderKpis() {
    const d = currentData;
    const equityInput = $('#strategy-equity');
    const startEquity = Number(equityInput.value);
    const equityValid = equityInput.value.trim() !== '' && Number.isFinite(startEquity) && startEquity >= 0;
    equityInput.setAttribute('aria-invalid', String(!equityValid));
    const ending = equityValid ? startEquity + d.performance.netPnlUsd : null;
    const metrics = [
      ['Win Rate', `${(d.performance.winRate * 100).toFixed(2)}%`, 'Eksekusi historis family-tagged · 0,01 lot', 'reference'],
      ['Profit Factor', NUMBER.format(d.performance.profitFactor), 'Eksekusi historis family-tagged · 0,01 lot', 'reference'],
      ['Net Pips', PIPS.format(d.performance.netPips), 'Acuan pips 0,01 lot · bukan hasil hitung ulang per lot', 'reference'],
      ['Net PnL (USD)', signedMoney(d.performance.netPnlUsd), 'Estimasi kombinasi dan lot yang dipilih', d.performance.netPnlUsd >= 0 ? 'positive' : 'negative'],
      ['Starting Equity', equityValid ? money(startEquity) : '—', 'Nilai simulasi yang Anda pilih'],
      ['Estimated Ending Equity', equityValid ? money(ending) : '—', 'Starting Equity + Net PnL simulasi; bukan saldo akun live', 'positive'],
      ['Peak Open', whole(d.performance.peakOpen), 'Tumpang tindih posisi maksimum · historis 0,01 lot', 'reference'],
      ['Closed Trades', whole(d.performance.closedTrades), 'Trade tertutup dalam kombinasi aktif'],
      ['Win Trades', whole(d.performance.wins), 'Hasil tertutup positif menurut histori 0,01 lot'],
      ['Loss Trades', whole(d.performance.losses), 'Hasil tertutup negatif menurut histori 0,01 lot'],
      ['Days With Close', whole(d.performance.daysWithClose), 'Dari seluruh 293 hari kalender'],
      ['Positive Days', whole(d.performance.positiveDays), 'Hari bertanggal dengan net closed PnL positif'],
      ['Negative Days', whole(d.performance.negativeDays), 'Hari bertanggal dengan net closed PnL negatif'],
      ['Best Day PnL', signedMoney(d.dailyRisk.bestDay?.pnlUsd), d.dailyRisk.bestDay ? DAY_DATE.format(dateObject(d.dailyRisk.bestDay.date)) : '—', 'positive'],
      ['Worst Day PnL', signedMoney(d.dailyRisk.worstDay?.pnlUsd), d.dailyRisk.worstDay ? DAY_DATE.format(dateObject(d.dailyRisk.worstDay.date)) : '—', 'negative'],
      ['Consecutive Loss Days (Max)', whole(d.dailyRisk.maxConsecutiveLossDays), 'Hari tanpa trade diabaikan; hari close dengan net nol mereset streak'],
      ['Worst Consecutive Losing-Day PnL', signedMoney(d.dailyRisk.worstConsecutiveLossPnlUsd), 'Kerugian net terakumulasi pada rangkaian loss terburuk', 'negative'],
    ];
    const groups = [['Performance', metrics.slice(0, 6)], ['Trading Activity', metrics.slice(6, 11)], ['Daily Risk', metrics.slice(11)]];
    const card = ([label, value, sub, kind]) => `<article class="strategy-kpi"><span class="strategy-kpi-label">${escapeHtml(label)}${kind === 'reference' ? '<span class="tip" title="Mengacu pada eksekusi historis family-tagged 0,01 lot, sesuai workbook.">i</span>' : ''}</span><strong class="strategy-kpi-value ${kind === 'positive' ? 'positive' : kind === 'negative' ? 'negative' : ''}">${escapeHtml(value)}</strong><small class="strategy-kpi-sub">${escapeHtml(sub)}</small></article>`;
    $('#strategy-kpis').innerHTML = groups.map(([title, items]) => `<section class="strategy-kpi-group"><h3>${title}</h3><div class="strategy-kpi-grid">${items.map(card).join('')}</div></section>`).join('');
  }

  function renderEquityOptions() {
    const values = currentData.recommendedEquity;
    const cards = [
      ['OPT1', 'Equity DD & Margin Stress', values.opt1, 'Memperhitungkan drawdown dan paparan posisi simultan pada histori, ditambah buffer model.', 'Estimasi ini memakai drawdown historis family-tagged, puncak posisi terbuka, dan asumsi stress workbook. Nilai aktual bergantung pada kondisi pasar dan broker.'],
      ['OPT2', 'Consecutive Loss Stress', values.opt2, 'Menggunakan akumulasi kerugian pada rangkaian hari loss terburuk, serta margin dan buffer model.', 'Hari tanpa trade dilewati. Hari dengan posisi tertutup dan hasil nol memutus rangkaian loss. Ini bukan jumlah hari loss dikali rata-rata kerugian.'],
      ['OPT3', 'Worst Daily Loss Stress', values.opt3, 'Menggunakan kerugian net terbesar dalam satu hari bertanggal, serta margin dan buffer model.', 'Perkiraan didasarkan pada hari terburuk dari data historis kombinasi aktif. Kebutuhan margin nyata dapat berubah menurut spesifikasi broker dan harga.'],
    ];
    $('#strategy-options').innerHTML = cards.map(([opt, title, value, copy, detail]) => `<article class="strategy-equity"><span class="opt">${opt}</span><h3>${escapeHtml(title)}</h3><strong>${money(value)}</strong><p>${escapeHtml(copy)}</p><details><summary>Cara membaca estimasi</summary><p>${escapeHtml(detail)}</p></details></article>`).join('');
  }

  function chartGeometry(rows) {
    const width = 1080, height = 360, left = 76, right = 1052, top = 23, bottom = 305;
    const values = rows.map(row => row.cumulativePnlUsd);
    let min = Math.min(0, ...values), max = Math.max(0, ...values);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
    const x = index => left + (rows.length <= 1 ? 0 : index / (rows.length - 1)) * (right - left);
    const y = value => bottom - ((value - min) / (max - min)) * (bottom - top);
    const points = rows.map((row, index) => ({ ...row, x: x(index), y: y(row.cumulativePnlUsd) }));
    const ticks = Array.from({ length: 5 }, (_, index) => max - index * ((max - min) / 4));
    const zeroY = y(0);
    const linePath = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    const fillPath = `${linePath} L${right},${zeroY.toFixed(2)} L${left},${zeroY.toFixed(2)} Z`;
    const axisIndices = [...new Set([0, Math.round((rows.length - 1) / 3), Math.round((rows.length - 1) * 2 / 3), rows.length - 1])];
    const currencyAxis = value => {
      const abs = Math.abs(value);
      const short = abs >= 1000 ? `${NUMBER.format(abs / 1000)}k` : NUMBER.format(abs);
      return `${value < 0 ? '−' : value > 0 ? '+' : ''}$${short}`;
    };
    return { width, height, left, right, top, bottom, points, ticks, y, linePath, fillPath, axisIndices, currencyAxis };
  }

  function renderChart() {
    const rows = currentData.daily;
    const g = chartGeometry(rows);
    const grid = g.ticks.map(value => `<line class="strategy-chart-grid" x1="${g.left}" x2="${g.right}" y1="${g.y(value)}" y2="${g.y(value)}"></line><text x="${g.left - 10}" y="${g.y(value) + 4}" text-anchor="end">${escapeHtml(g.currencyAxis(value))}</text>`).join('');
    const dates = g.axisIndices.map(index => `<text x="${g.points[index].x}" y="${g.bottom + 30}" text-anchor="${index === 0 ? 'start' : index === g.points.length - 1 ? 'end' : 'middle'}">${SHORT_DATE.format(dateObject(rows[index].date))}</text>`).join('');
    $('#strategy-chart-stage').innerHTML = `<svg class="strategy-chart-svg" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="Grafik kumulatif Net PnL harian dari ${rows[0].date} sampai ${rows.at(-1).date}. Gunakan panah kiri atau kanan untuk meninjau titik harian." tabindex="0"><defs><linearGradient id="strategyFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#55d5b0" stop-opacity=".22"></stop><stop offset="1" stop-color="#55d5b0" stop-opacity=".005"></stop></linearGradient></defs>${grid}<line class="strategy-chart-axis" x1="${g.left}" x2="${g.right}" y1="${g.bottom}" y2="${g.bottom}"></line><path class="strategy-chart-fill" d="${g.fillPath}"></path><path class="strategy-chart-line" d="${g.linePath}"></path>${dates}<g id="strategy-chart-focus" style="display:none"><line id="strategy-focus-line" class="strategy-chart-focus" y1="${g.top}" y2="${g.bottom}"></line><circle id="strategy-focus-ring" class="strategy-chart-dot-ring" r="6"></circle><circle id="strategy-focus-dot" class="strategy-chart-dot" r="2.2"></circle></g></svg>`;
    $('#strategy-chart-total').textContent = signedMoney(currentData.performance.netPnlUsd);
    const svg = $('.strategy-chart-svg');
    const focus = $('#strategy-chart-focus');
    const tooltip = $('#strategy-chart-tooltip');
    const card = $('.strategy-chart-card');
    const showPoint = index => {
      chartActiveIndex = Math.max(0, Math.min(g.points.length - 1, index));
      const point = g.points[chartActiveIndex];
      focus.style.display = '';
      $('#strategy-focus-line').setAttribute('x1', point.x);
      $('#strategy-focus-line').setAttribute('x2', point.x);
      for (const selector of ['#strategy-focus-ring', '#strategy-focus-dot']) {
        $(selector).setAttribute('cx', point.x);
        $(selector).setAttribute('cy', point.y);
      }
      const pnlClass = point.pnlUsd > 0 ? 'up' : point.pnlUsd < 0 ? 'down' : '';
      tooltip.innerHTML = `<div class="strategy-tooltip-date">${DAY_DATE.format(dateObject(point.date))} · ${escapeHtml(point.day)}</div><div class="strategy-tooltip-row"><span>Net PnL hari ini</span><strong class="${pnlClass}">${signedMoney(point.pnlUsd)}</strong></div><div class="strategy-tooltip-row"><span>Cumulative PnL</span><strong>${signedMoney(point.cumulativePnlUsd)}</strong></div><div class="strategy-tooltip-row"><span>Kombinasi</span><strong>${escapeHtml(currentData.combination === 'ALL' ? 'ALL' : comboLabel(currentData.families))}</strong></div>`;
      tooltip.classList.add('visible');
      const cardRect = card.getBoundingClientRect();
      const screen = svg.createSVGPoint(); screen.x = point.x; screen.y = point.y;
      const screenPoint = screen.matrixTransform(svg.getScreenCTM());
      const px = screenPoint.x - cardRect.left;
      tooltip.style.left = `${Math.max(10, Math.min(cardRect.width - 240, px - 105))}px`;
      tooltip.style.top = '42px';
      tooltip.dataset.index = String(chartActiveIndex);
    };
    svg.addEventListener('pointermove', event => {
      const local = svg.createSVGPoint(); local.x = event.clientX; local.y = event.clientY;
      const point = local.matrixTransform(svg.getScreenCTM().inverse());
      const index = Math.round((point.x - g.left) / (g.right - g.left) * (g.points.length - 1));
      showPoint(index);
    });
    svg.addEventListener('pointerleave', () => { focus.style.display = 'none'; tooltip.classList.remove('visible'); });
    svg.addEventListener('focus', () => showPoint(chartActiveIndex));
    svg.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); showPoint(chartActiveIndex + (event.key === 'ArrowRight' ? 1 : -1));
    });
  }

  function renderTable() {
    const allRows = [...currentData.daily].sort((a, b) => a.date.localeCompare(b.date) * (sortDescending ? -1 : 1));
    const perPage = 20;
    const pages = Math.max(1, Math.ceil(allRows.length / perPage));
    tablePage = Math.max(1, Math.min(tablePage, pages));
    const rows = allRows.slice((tablePage - 1) * perPage, tablePage * perPage);
    const columns = ['Date', 'Day', 'Win', 'Loss', 'Closed Trades', 'Win Rate', 'PnL USD', 'Cumulative PnL USD', 'Day Status', 'Weekly PnL', 'Week Status', 'Monthly PnL', 'Month Status'];
    const cellMoney = value => `<span class="${value > 0 ? 'up' : value < 0 ? 'down' : 'muted'}">${signedMoney(value)}</span>`;
    const badge = value => `<span class="strategy-status ${statusClass(value)}">${escapeHtml(value)}</span>`;
    const body = rows.map(row => `<tr><td>${row.date}</td><td>${escapeHtml(row.day)}</td><td>${whole(row.wins)}</td><td>${whole(row.losses)}</td><td>${whole(row.closedTrades)}</td><td>${row.winRate == null ? '—' : `${(row.winRate * 100).toFixed(1)}%`}</td><td>${cellMoney(row.pnlUsd)}</td><td>${cellMoney(row.cumulativePnlUsd)}</td><td>${badge(row.dayStatus)}</td><td>${cellMoney(row.weeklyPnlUsd)}</td><td>${badge(row.weekStatus)}</td><td>${cellMoney(row.monthlyPnlUsd)}</td><td>${badge(row.monthStatus)}</td></tr>`).join('');
    $('#strategy-table-container').innerHTML = `<div class="strategy-table-shell"><table class="strategy-table"><thead><tr>${columns.map((column, index) => `<th scope="col">${index === 0 ? `<button class="strategy-date-sort" type="button" id="strategy-date-sort" aria-label="Urutkan tanggal">${column} ${sortDescending ? '↓' : '↑'}</button>` : column}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div><div class="strategy-table-tools"><span>Menampilkan ${(tablePage - 1) * perPage + 1}–${Math.min(tablePage * perPage, allRows.length)} dari ${allRows.length} hari</span><div class="controls"><button class="btn btn-quiet" id="strategy-prev" type="button" ${tablePage <= 1 ? 'disabled' : ''}>Sebelumnya</button><span>Halaman ${tablePage} / ${pages}</span><button class="btn btn-quiet" id="strategy-next" type="button" ${tablePage >= pages ? 'disabled' : ''}>Berikutnya</button></div></div>`;
    $('#strategy-date-sort').addEventListener('click', () => { sortDescending = !sortDescending; tablePage = 1; renderTable(); });
    $('#strategy-prev').addEventListener('click', () => { tablePage--; renderTable(); });
    $('#strategy-next').addEventListener('click', () => { tablePage++; renderTable(); });
  }

  function renderResults() {
    renderKpis();
    renderEquityOptions();
    renderChart();
    renderTable();
  }

  function updateProfileFromCombo() {
    const families = $('#strategy-families').value.split('+');
    const match = Object.entries(PRESETS).find(([, preset]) => familiesKey(preset) === familiesKey(families));
    $('#strategy-profile').value = match?.[0] || 'CUSTOM';
  }

  function applyProfile(profile) {
    if (profile === 'CUSTOM') return;
    $('#strategy-families').value = familiesKey(PRESETS[profile]);
    $('#strategy-active-combo').textContent = `Kombinasi aktif: ${comboLabel(PRESETS[profile])}`;
    requestEstimator();
  }

  function renderStartingEquity() {
    if (currentData) renderKpis();
  }

  async function verifySession() {
    showGate('strategy-gate');
    try {
      const result = await sb.auth.getSession();
      session = result.data?.session || null;
      if (!session) { showGate('strategy-login'); return; }
      $('#strategy-user-email').textContent = session.user.email || '';
      $('#strategy-avatar').textContent = (session.user.email || 'H').slice(0, 1).toUpperCase();
      const roleResult = await sb.rpc('helix_current_role');
      if (roleResult.error || roleResult.data !== 'member') { showGate('strategy-denied'); return; }
      $('#strategy-app').hidden = false;
      renderFamilyOptions();
      await requestEstimator();
    } catch {
      $('#strategy-error-copy').textContent = 'Sesi tidak dapat diverifikasi. Masuk kembali ke portal VIP, lalu buka ulang halaman ini.';
      showGate('strategy-error');
    }
  }

  $('#strategy-profile').addEventListener('change', event => applyProfile(event.target.value));
  $('#strategy-families').addEventListener('change', () => { updateProfileFromCombo(); requestEstimator(); });
  $('#strategy-lot').addEventListener('change', requestEstimator);
  $('#strategy-equity').addEventListener('input', renderStartingEquity);
  $('#strategy-reset').addEventListener('click', () => {
    $('#strategy-lot').value = '0.01';
    $('#strategy-profile').value = 'AGGRESSIVE';
    $('#strategy-families').value = 'ML+RL+SHL+LGL';
    $('#strategy-equity').value = '5000';
    sortDescending = false; tablePage = 1;
    updateProfileFromCombo();
    requestEstimator();
  });
  $('#strategy-retry').addEventListener('click', requestEstimator);
  $('#strategy-logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.replace('/vip/login/');
  });
  verifySession();
})();
