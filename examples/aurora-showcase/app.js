// AURORA — starfield canvas, live clock, theme toggle. Vanilla JS, zero deps.
(() => {
  const canvas = document.getElementById('stars');
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    let W = (canvas.width = window.innerWidth);
    let H = (canvas.height = window.innerHeight);

    const makeStar = () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + 0.3, phase: Math.random() * Math.PI * 2 });
    const stars = Array.from({ length: 180 }, makeStar);
    let shot = null;
    let lastShot = 0;

    const frame = (t) => {
      ctx.clearRect(0, 0, W, H);

      for (const s of stars) {
        const tw = 0.45 + 0.55 * Math.abs(Math.sin(t / 900 + s.phase));
        ctx.globalAlpha = tw;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!shot && t - lastShot > 7000) {
        shot = { x: Math.random() * W * 0.8, y: Math.random() * H * 0.25, vx: 9 + Math.random() * 5, vy: 4.5 + Math.random() * 2.5, life: 1 };
        lastShot = t;
      }
      if (shot) {
        shot.x += shot.vx; shot.y += shot.vy; shot.life -= 0.02;
        const grad = ctx.createLinearGradient(shot.x, shot.y, shot.x - shot.vx * 8, shot.y - shot.vy * 8);
        grad.addColorStop(0, 'rgba(255,255,255,' + Math.max(shot.life, 0) + ')');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = 1; ctx.strokeStyle = grad; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(shot.x, shot.y); ctx.lineTo(shot.x - shot.vx * 8, shot.y - shot.vy * 8); ctx.stroke();
        if (shot.life <= 0) shot = null;
      }

      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    window.addEventListener('resize', () => { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; });
  }

  // Live footer clock
  const timeEl = document.getElementById('local-time');
  if (timeEl) {
    const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tick = () => { timeEl.textContent = fmt.format(new Date()); };
    tick();
    setInterval(tick, 1000);
  }

  // Theme toggle
  const toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const next = document.body.getAttribute('data-theme') === 'light' ? 'aurora' : 'light';
      document.body.setAttribute('data-theme', next);
    });
  }

  console.log('%cAURORA', 'color:#8b5cf6;font-weight:bold;font-size:16px', '— calm software, built by three MCP agents.');
})();
