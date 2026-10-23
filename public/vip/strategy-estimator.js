(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const FAMILIES = ['ML', 'RL', 'SHL', 'LGL'];
  const LOTS = ['0.01', '0.02', '0.03', '0.05', '0.10', '0.20', '0.30', '0.50', '1.00', '2.00', '3.00', '5.00'];
  const PRESETS = { SAFE: ['ML', 'RL'], MEDIUM: ['ML', 'RL', 'SHL'], AGGRESSIVE: [...FAMILIES] };
  const COMBINATIONS = Array.from({ length: 16 }, (_, mask) => FAMILIES.filter((_, index) => mask & (1 << index))).filter(value => value.length)
    .sort((a, b) => a.length - b.length || FAMILIES.indexOf(a[0]) - FAMILIES.indexOf(b[0]) || a.map(f => FAMILIES.indexOf(f)).join('').localeCompare(b.map(f => FAMILIES.indexOf(f)).join('')));
  const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const PIPS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const DAY_DATE = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const SHORT_DATE = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const sb = supabase.createClient('https://wouwoefzghecuiknznvs.supabase.co', 'sb_publishable_FDLLBcmYFGiS9PDbyvgDtQ_UWUB8fUc');
  let session = null;
  let currentData = null;
  let requestSequence = 0;
  let tablePage = 1;
  let sortDescending = false;
  let chartActiveIndex = 0;
  let sessionCheckStarted = false;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const money = value => Number.isFinite(value) ? USD.format(value) : '—';
  const whole = value => Number.isFinite(value) ? NUMBER.format(value) : '—';
  const signedMoney = value => Number.isFinite(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${USD.format(Math.abs(value))}` : '—';
  const familiesKey = families => families.join('+');
  const comboLabel = families => families.join(' + ');
  const familyLabel = families => families.join(' + ');
  const weekdayLabel = value => ({ Monday: 'Senin', Tuesday: 'Selasa', Wednesday: 'Rabu', Thursday: 'Kamis', Friday: 'Jumat', Saturday: 'Sabtu', Sunday: 'Minggu' })[value] || value;
  const statusClass = status => status === 'NEGATIVE' ? 'negative' : status === 'NO TRADE' ? 'no-trade' : status === 'FLAT' ? 'flat' : '';
  const dateObject = iso => new Date(`${iso}T00:00:00Z`);

  function showGate(id) {
    for (const node of [$('#strategy-gate'), $('#strategy-login'), $('#strategy-denied'), $('#strategy-error'), $('#strategy-app')]) node.hidden = node.id !== id;
  }

  function renderFamilyOptions() {
    $('#strategy-lot').innerHTML = LOTS.map(lot => `<option value="${lot}">${lot}</option>`).join('');
    $('#strategy-families').innerHTML = COMBINATIONS.map(families => {
      const name = familiesKey(families);
      const countLabel = `${families.length} strategi`;
      const label = families.length === 4 ? `${countLabel} · ${name} · SEMUA` : `${countLabel} · ${comboLabel(families)}`;
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
    $('#strategy-notice').textContent = 'Memperbarui hasil berdasarkan data acuan…';
    try {
      const result = await fetch(url, { headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json' }, cache: 'no-store' });
      const body = await result.json();
      if (!result.ok) throw new Error(body.message || body.error || `Permintaan gagal (${result.status}).`);
      if (sequence !== requestSequence) return;
      currentData = body;
      tablePage = 1;
      $('#strategy-active-combo').textContent = `Kombinasi aktif: ${familyLabel(body.families)} · Ukuran lot ${body.lot}`;
      $('#strategy-chart-family').textContent = body.combination === 'ALL' ? 'SEMUA' : body.combination;
      $('#strategy-notice').textContent = `Mode ${$('#strategy-profile').selectedOptions[0].textContent} · statistik historis diselaraskan dengan transaksi berlabel strategi.`;
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
      ['Tingkat Kemenangan', `${(d.performance.winRate * 100).toFixed(2)}%`, 'Transaksi historis berlabel strategi · 0,01 lot', 'reference'],
      ['Faktor Profit', NUMBER.format(d.performance.profitFactor), 'Transaksi historis berlabel strategi · 0,01 lot', 'reference'],
      ['Pips Bersih', PIPS.format(d.performance.netPips), 'Acuan 0,01 lot · tidak dihitung ulang per ukuran lot', 'reference'],
      ['Laba/Rugi Bersih (USD)', signedMoney(d.performance.netPnlUsd), 'Perkiraan kombinasi dan ukuran lot terpilih', d.performance.netPnlUsd >= 0 ? 'positive' : 'negative'],
      ['Modal Awal', equityValid ? money(startEquity) : '—', 'Nilai simulasi pilihan Anda'],
      ['Perkiraan Modal Akhir', equityValid ? money(ending) : '—', 'Modal awal + laba/rugi simulasi; bukan saldo akun aktif', 'positive'],
      ['Posisi Terbuka Bersamaan', whole(d.performance.peakOpen), 'Jumlah maksimum bersamaan · histori 0,01 lot', 'reference'],
      ['Transaksi Ditutup', whole(d.performance.closedTrades), 'Transaksi ditutup dalam kombinasi terpilih'],
      ['Transaksi Untung', whole(d.performance.wins), 'Hasil positif menurut histori 0,01 lot'],
      ['Transaksi Rugi', whole(d.performance.losses), 'Hasil negatif menurut histori 0,01 lot'],
      ['Hari dengan Transaksi Ditutup', whole(d.performance.daysWithClose), 'Dari seluruh 293 hari kalender'],
      ['Hari Untung', whole(d.performance.positiveDays), 'Hari dengan laba/rugi bersih positif'],
      ['Hari Rugi', whole(d.performance.negativeDays), 'Hari dengan laba/rugi bersih negatif'],
      ['Laba/Rugi Harian Terbaik', signedMoney(d.dailyRisk.bestDay?.pnlUsd), d.dailyRisk.bestDay ? DAY_DATE.format(dateObject(d.dailyRisk.bestDay.date)) : '—', 'positive'],
      ['Laba/Rugi Harian Terburuk', signedMoney(d.dailyRisk.worstDay?.pnlUsd), d.dailyRisk.worstDay ? DAY_DATE.format(dateObject(d.dailyRisk.worstDay.date)) : '—', 'negative'],
      ['Hari Rugi Berturut-turut (Maks.)', whole(d.dailyRisk.maxConsecutiveLossDays), 'Hari tanpa transaksi diabaikan; hasil nol mengakhiri rentetan rugi'],
      ['Kerugian Terbesar dalam Rentetan', signedMoney(d.dailyRisk.worstConsecutiveLossPnlUsd), 'Akumulasi rugi bersih pada rentetan hari rugi terburuk', 'negative'],
    ];
    const groups = [['Kinerja', metrics.slice(0, 6)], ['Aktivitas Transaksi', metrics.slice(6, 11)], ['Risiko Harian', metrics.slice(11)]];
    const card = ([label, value, sub, kind]) => `<article class="strategy-kpi"><span class="strategy-kpi-label">${escapeHtml(label)}${kind === 'reference' ? '<span class="tip" title="Mengacu pada data historis berlabel strategi dengan ukuran 0,01 lot.">i</span>' : ''}</span><strong class="strategy-kpi-value ${kind === 'positive' ? 'positive' : kind === 'negative' ? 'negative' : ''}">${escapeHtml(value)}</strong><small class="strategy-kpi-sub">${escapeHtml(sub)}</small></article>`;
    $('#strategy-kpis').innerHTML = groups.map(([title, items]) => `<section class="strategy-kpi-group"><h3>${title}</h3><div class="strategy-kpi-grid">${items.map(card).join('')}</div></section>`).join('');
  }

  function renderEquityOptions() {
    const values = currentData.recommendedEquity;
    const cards = [
      ['OPT1', 'Tekanan Penurunan Modal & Margin', values.opt1, 'Memperhitungkan penurunan modal dan paparan posisi bersamaan pada histori, ditambah cadangan model.', 'Estimasi memakai penurunan modal historis, puncak posisi terbuka, dan asumsi tekanan pada data acuan. Nilai aktual bergantung pada kondisi pasar dan broker.'],
      ['OPT2', 'Tekanan Rentetan Hari Rugi', values.opt2, 'Menggunakan akumulasi kerugian pada rentetan hari rugi terburuk, serta margin dan cadangan model.', 'Hari tanpa transaksi dilewati. Hari dengan hasil nol mengakhiri rentetan rugi. Nilai ini bukan jumlah hari rugi dikalikan rata-rata kerugian.'],
      ['OPT3', 'Tekanan Kerugian Harian Terburuk', values.opt3, 'Menggunakan kerugian bersih terbesar dalam satu hari, serta margin dan cadangan model.', 'Perkiraan didasarkan pada hari terburuk dalam data historis kombinasi aktif. Kebutuhan margin nyata dapat berubah menurut spesifikasi broker dan harga.'],
    ];
    $('#strategy-options').innerHTML = cards.map(([opt, title, value, copy, detail]) => `<article class="strategy-equity"><span class="opt">${opt}</span><h3>${escapeHtml(title)}</h3><strong>${money(value)}</strong><p>${escapeHtml(copy)}</p><details><summary>Cara memahami perkiraan</summary><p>${escapeHtml(detail)}</p></details></article>`).join('');
  }

  function chartGeometry(rows) {
    const width = 960, height = 270, left = 76, right = 936, top = 18, bottom = 224;
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
    const dates = g.axisIndices.map(index => `<text x="${g.points[index].x}" y="${g.bottom + 23}" text-anchor="${index === 0 ? 'start' : index === g.points.length - 1 ? 'end' : 'middle'}">${SHORT_DATE.format(dateObject(rows[index].date))}</text>`).join('');
    $('#strategy-chart-stage').innerHTML = `<svg class="strategy-chart-svg" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="Grafik akumulasi laba/rugi bersih harian dari ${rows[0].date} sampai ${rows.at(-1).date}. Gunakan tombol panah kiri atau kanan untuk meninjau titik harian." tabindex="0"><defs><linearGradient id="strategyFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#55d5b0" stop-opacity=".18"></stop><stop offset="1" stop-color="#55d5b0" stop-opacity=".01"></stop></linearGradient></defs>${grid}<line class="strategy-chart-axis" x1="${g.left}" x2="${g.right}" y1="${g.bottom}" y2="${g.bottom}"></line><path class="strategy-chart-fill" d="${g.fillPath}"></path><path class="strategy-chart-line" d="${g.linePath}"></path>${dates}<g id="strategy-chart-focus" style="display:none"><line id="strategy-focus-line" class="strategy-chart-focus" y1="${g.top}" y2="${g.bottom}"></line><circle id="strategy-focus-ring" class="strategy-chart-dot-ring" r="6"></circle><circle id="strategy-focus-dot" class="strategy-chart-dot" r="2.2"></circle></g></svg>`;
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
      tooltip.innerHTML = `<div class="strategy-tooltip-date">${DAY_DATE.format(dateObject(point.date))} · ${escapeHtml(weekdayLabel(point.day))}</div><div class="strategy-tooltip-row"><span>Laba/rugi hari ini</span><strong class="${pnlClass}">${signedMoney(point.pnlUsd)}</strong></div><div class="strategy-tooltip-row"><span>Akumulasi laba/rugi</span><strong>${signedMoney(point.cumulativePnlUsd)}</strong></div><div class="strategy-tooltip-row"><span>Kombinasi strategi</span><strong>${escapeHtml(currentData.combination === 'ALL' ? 'SEMUA' : familyLabel(currentData.families))}</strong></div>`;
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
    const columns = ['Tanggal', 'Hari', 'Untung', 'Rugi', 'Transaksi Ditutup', 'Tingkat Kemenangan', 'Laba/Rugi (USD)', 'Akumulasi (USD)', 'Status Harian', 'Laba/Rugi Mingguan', 'Status Mingguan', 'Laba/Rugi Bulanan', 'Status Bulanan'];
    const cellMoney = value => `<span class="${value > 0 ? 'up' : value < 0 ? 'down' : 'muted'}">${signedMoney(value)}</span>`;
    const translateStatus = value => ({ 'NO TRADE': 'Tanpa transaksi', FLAT: 'Impas', NEGATIVE: 'Rugi', POSITIVE: 'Untung' })[value] || value;
    const badge = value => `<span class="strategy-status ${statusClass(value)}">${escapeHtml(translateStatus(value))}</span>`;
    const body = rows.map(row => `<tr><td>${row.date}</td><td>${escapeHtml(weekdayLabel(row.day))}</td><td>${whole(row.wins)}</td><td>${whole(row.losses)}</td><td>${whole(row.closedTrades)}</td><td>${row.winRate == null ? '—' : `${(row.winRate * 100).toFixed(1)}%`}</td><td>${cellMoney(row.pnlUsd)}</td><td>${cellMoney(row.cumulativePnlUsd)}</td><td>${badge(row.dayStatus)}</td><td>${cellMoney(row.weeklyPnlUsd)}</td><td>${badge(row.weekStatus)}</td><td>${cellMoney(row.monthlyPnlUsd)}</td><td>${badge(row.monthStatus)}</td></tr>`).join('');
    $('#strategy-table-container').innerHTML = `<div class="strategy-table-shell"><table class="strategy-table"><thead><tr>${columns.map((column, index) => `<th scope="col">${index === 0 ? `<button class="strategy-date-sort" type="button" id="strategy-date-sort" aria-label="Urutkan tanggal">${column} ${sortDescending ? '↓' : '↑'}</button>` : column}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div><div class="strategy-table-tools"><span>Menampilkan ${(tablePage - 1) * perPage + 1}–${Math.min(tablePage * perPage, allRows.length)} dari ${allRows.length} hari</span><div class="controls"><button class="btn btn-quiet" id="strategy-prev" type="button" ${tablePage <= 1 ? 'disabled' : ''}>Sebelumnya</button><span>Halaman ${tablePage} dari ${pages}</span><button class="btn btn-quiet" id="strategy-next" type="button" ${tablePage >= pages ? 'disabled' : ''}>Berikutnya</button></div></div>`;
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
    $('#strategy-active-combo').textContent = `Kombinasi aktif: ${familyLabel(PRESETS[profile])}`;
    requestEstimator();
  }

  function renderStartingEquity() {
    if (currentData) renderKpis();
  }

  async function acceptSession(nextSession) {
      session = nextSession || null;
      if (!session) { showGate('strategy-login'); return; }
      $('#strategy-user-email').textContent = session.user.email || '';
      $('#strategy-avatar').textContent = (session.user.email || 'H').slice(0, 1).toUpperCase();
      const roleResult = await sb.rpc('helix_current_role');
      if (roleResult.error || roleResult.data !== 'member') { showGate('strategy-denied'); return; }
      showGate('strategy-app');
      renderFamilyOptions();
      await requestEstimator();
  }

  async function verifySession() {
    if (sessionCheckStarted) return;
    sessionCheckStarted = true;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      $('#strategy-error-copy').textContent = 'Pemeriksaan sesi terlalu lama. Muat ulang halaman atau masuk kembali ke portal VIP.';
      showGate('strategy-error');
    }, 12000);
    try {
      const { data, error } = await sb.auth.getSession();
      if (finished) return;
      if (error) throw error;
      const activeSession = data?.session || null;
      finished = true;
      clearTimeout(timer);
      await acceptSession(activeSession);
    } catch {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      $('#strategy-error-copy').textContent = 'Sesi tidak dapat diverifikasi. Muat ulang halaman atau masuk kembali ke portal VIP.';
      showGate('strategy-error');
    }
  }

  sb.auth.onAuthStateChange((event, nextSession) => {
    if (event === 'INITIAL_SESSION') return;
    if (event === 'SIGNED_OUT') { session = null; showGate('strategy-login'); return; }
    if (nextSession && ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
      session = nextSession;
      if (!$('#strategy-app').hidden) return;
      void acceptSession(nextSession).catch(() => {
        $('#strategy-error-copy').textContent = 'Sesi tidak dapat diverifikasi. Muat ulang halaman atau masuk kembali ke portal VIP.';
        showGate('strategy-error');
      });
    }
  });

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
