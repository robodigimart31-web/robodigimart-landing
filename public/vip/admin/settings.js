(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function renderSettings(data = {}) {
    const extra = JSON.stringify(data.currency_usd_rates || {}, null, 2);
    $('#content').innerHTML = `<div class="page-title"><div><div class="eyebrow">HELIX ADMIN</div><h1>General Settings</h1><p>Atur rate konversi yang dipakai pada All Performance dan ringkasan trading.</p></div></div><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Rate mata uang</h2><div class="panel-sub">Nilai ini dipakai untuk mengubah profit menjadi USD. Perubahan baru berlaku untuk tampilan statistik.</div></div></div><div class="field"><label for="setting-idr">IDR per USD</label><input class="input" id="setting-idr" type="number" min="1" max="1000000000" step="1" value="${Number(data.usd_idr_rate || 17500)}"></div><div class="field"><label>USC per USD</label><input class="input" value="${Number(data.usc_per_usd || 100)}" disabled><span class="panel-sub">Akun USC dibagi 100 sesuai ketentuan.</span></div><div class="field"><label for="setting-currencies">Rate USD mata uang lain (JSON)</label><textarea class="input" id="setting-currencies" rows="6" placeholder='{"EUR":1.08,"GBP":1.27}'>${esc(extra)}</textarea><span class="panel-sub">Isi faktor konversi satu unit mata uang ke USD, misalnya EUR 1.08 berarti 1 EUR = 1.08 USD. Rate yang belum diatur tidak dihitung.</span></div><div class="field"><label for="setting-reason">Alasan perubahan (audit)</label><input class="input" id="setting-reason" maxlength="300" placeholder="Contoh: menyesuaikan rate operasional"></div><div class="filterbar"><button class="btn btn-primary" id="settings-save">Simpan pengaturan</button><span class="panel-sub" id="settings-updated">${data.updated_at ? `Terakhir diubah ${new Date(data.updated_at).toLocaleString('id-ID')}` : ''}</span></div></section>`;
    document.querySelectorAll('#nav button').forEach(button => button.classList.toggle('active', button.dataset.page === 'General Settings'));
  }
  async function openSettings() { try { renderSettings(await api('admin/settings')); } catch (error) { $('#content').innerHTML = `<div class="notice error">${esc(error.message)}</div>`; } }
  document.addEventListener('click', async event => {
    const button = event.target.closest('#nav button[data-page="General Settings"]');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation(); state.page = 'General Settings'; await openSettings();
  }, true);
  document.addEventListener('click', async event => {
    const button = event.target.closest('#settings-save');
    if (!button) return;
    try {
      const rate = Number($('#setting-idr').value), reason = $('#setting-reason').value.trim();
      let currencies;
      try { currencies = JSON.parse($('#setting-currencies').value || '{}'); } catch { throw new Error('Format rate mata uang harus berupa JSON yang valid.'); }
      if (!Number.isFinite(rate) || rate <= 0 || reason.length < 3) throw new Error('Isi kurs USD/IDR yang valid dan alasan minimal 3 karakter.');
      if (!await HelixUI.confirm({ title: 'Konfirmasi perubahan rate', message: `Rate USD/IDR akan diubah menjadi ${rate.toLocaleString('id-ID')}. Statistik USD akan memakai kurs ini.`, confirmText: 'Simpan rate' })) return;
      button.disabled = true;
      await api('admin/settings', 'PATCH', { usd_idr_rate: rate, usc_per_usd: 100, currency_usd_rates: currencies, reason, confirmed: true });
      toast('General Settings berhasil diperbarui.');
      await openSettings();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
})();
