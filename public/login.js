const form = document.getElementById('login-form');
  const pw = document.getElementById('password');
  const err = document.getElementById('error');
  const btn = document.getElementById('submit');
  const toggle = document.getElementById('toggle');

  toggle.onclick = () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    toggle.textContent = show ? '隐藏' : '显示';
  };
  pw.oninput = () => err.classList.remove('show');

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.classList.remove('show');
    btn.disabled = true;
    btn.textContent = '验证中…';
    try {
      const res = await fetch('login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value }),
      });
      if (res.ok) {
        location.href = './';
      } else {
        err.classList.add('show');
        pw.select();
      }
    } catch {
      err.textContent = '网络异常，请重试';
      err.classList.add('show');
    }
    btn.disabled = false;
    btn.textContent = '进入看板';
  };
