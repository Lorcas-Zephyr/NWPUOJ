(function () {
  'use strict';
  var dialog = document.getElementById('ban-editor');
  if (!dialog) return;
  var form = dialog.querySelector('[data-ban-form]');
  var submit = form.querySelector('[data-ban-submit]');
  var errorBox = form.querySelector('[data-ban-error]');
  var targetLabel = form.querySelector('[data-ban-target]');
  var profileButton = document.querySelector('[data-open-user-ban]');
  var target = null, busy = false;
  var api = window.NWPUOJApi;
  var dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function message(error) { errorBox.textContent = error.message || String(error); errorBox.hidden = false; }
  function headers() { return { 'Content-Type': 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content, 'Idempotency-Key': window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2) }; }
  function fields() {
    var ip = form.elements.type.value === 'ip';
    form.querySelector('[data-ban-username-field]').hidden = !!target || ip;
    form.elements.username.required = !target && !ip;
    form.querySelector('[data-ban-ip-field]').hidden = !ip;
    form.elements.login_ip.hidden = !target;
    form.elements.ip.hidden = !!target;
    form.elements.login_ip.required = ip && !!target;
    form.elements.ip.required = ip && !target;
    form.querySelector('[data-ban-expiry-field]').hidden = form.elements.duration.value !== 'custom';
    form.querySelector('[data-ban-ip-impact]').hidden = !ip;
    submit.disabled = busy || (ip && !!target && !form.elements.login_ip.options.length);
  }
  async function profileState(id) {
    return (await api.readResource('/api/v2/admin/bans/users/' + encodeURIComponent(id))).data;
  }
  async function refreshProfile() {
    if (!profileButton) return;
    try {
      var state = await profileState(profileButton.dataset.userId);
      profileButton.querySelector('[data-ban-button-label]').textContent = state.bans.length ? '追加封禁' : '封禁';
    } catch (error) { profileButton.title = error.message; }
  }
  async function open(button) {
    form.reset();
    if (form.elements.expires_at._flatpickr) form.elements.expires_at._flatpickr.clear();
    errorBox.hidden = true;
    target = button.dataset.userId ? { id: Number(button.dataset.userId), username: button.dataset.username } : null;
    targetLabel.hidden = !target;
    targetLabel.textContent = target ? target.username || '用户 #' + target.id : '';
    form.elements.type.value = button.dataset.type || 'account';
    form.elements.ip.value = button.dataset.ip || '';
    form.elements.login_ip.replaceChildren();
    var appending = button.hasAttribute('data-append-ban') || button.textContent.includes('追加');
    dialog.querySelector('h2').textContent = appending ? '追加封禁' : '新增封禁';
    submit.textContent = appending ? '追加封禁' : '确认封禁';
    dialog.__appOpener = button;
    dialog.showModal();
    document.body.classList.add('is-dialog-open');
    busy = !!target;
    fields();
    if (target) {
      try {
        var data = await profileState(target.id);
        data.ips.forEach(function (record) {
          var option = document.createElement('option');
          option.value = record.ip;
          option.textContent = record.ip + ' · ' + dateFormat.format(new Date(record.last_login));
          form.elements.login_ip.appendChild(option);
        });
        if (button.dataset.ip) form.elements.login_ip.value = button.dataset.ip;
        if (!data.ips.length && form.elements.type.value === 'ip') message('该账号暂无可封禁的登录 IP。');
      } catch (error) { message(error); }
      finally { busy = false; fields(); }
    }
  }
  document.querySelectorAll('[data-open-user-ban], [data-new-ban], [data-append-ban]').forEach(function (button) {
    button.addEventListener('click', function () { open(button); });
  });
  form.elements.type.addEventListener('change', fields);
  form.elements.duration.addEventListener('change', fields);
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;
    errorBox.hidden = true;
    var duration = form.elements.duration.value, expiry = null;
    if (duration === 'custom') {
      var raw = form.elements.expires_at.value;
      expiry = new Date(raw + ':00+08:00');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        message('请选择未来的解封时间。'); return;
      }
    } else if (duration !== 'permanent') expiry = new Date(Date.now() + Number(duration) * 3600000);
    var payload = { type: form.elements.type.value, permanent: duration === 'permanent', expires_at: expiry ? expiry.toISOString() : null };
    if (target) payload.user_id = target.id;
    else payload.username = form.elements.username.value.trim();
    if (payload.type === 'ip') payload.ip = target ? form.elements.login_ip.value : form.elements.ip.value.trim();
    busy = true; fields();
    try {
      await api.writeResource('/api/v2/admin/bans', 'POST', payload, { headers: headers() });
      dialog.close();
      if (!profileButton) window.location.reload();
      else {
        await refreshProfile();
        if (window.NWPUOJApp) window.NWPUOJApp.showToast('封禁已生效。', 'success');
      }
    } catch (error) { message(error); }
    finally { busy = false; fields(); }
  });
  document.querySelectorAll('[data-lift-ban]').forEach(function (button) {
    button.addEventListener('click', async function () {
      if (!window.confirm('取消这条封禁记录？其他仍生效的封禁不会被取消。')) return;
      button.disabled = true;
      try {
        await api.writeResource('/api/v2/admin/bans/' + encodeURIComponent(button.dataset.liftBan), 'DELETE', {}, { headers: headers() });
        window.location.reload();
      } catch (error) {
        button.disabled = false;
        if (window.NWPUOJApp) window.NWPUOJApp.showToast(error.message, 'danger');
      }
    });
  });
  refreshProfile();
})();
