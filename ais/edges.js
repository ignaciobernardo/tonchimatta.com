/* ---------------------------------------------------------------
   Bordes ASCII con física: repelencia, curva, rebote lento,
   disparo al click rápido y jitter permanente al arrastrar.
----------------------------------------------------------------*/
(function () {
  'use strict';

  var PATTERN = '010101010';
  var COLS    = 4;          // columnas de dígitos por borde

  // Parámetros de la simulación
  var LINE_HEIGHT   = 22;   // separación vertical entre dígitos
  var REPEL_RADIUS  = 165;  // alcance del cursor / dedo
  var REPEL_FORCE   = 3400; // intensidad de la repelencia
  var SPRING        = 26;   // fuerza de retorno al lugar
  var DAMPING       = 5.2;  // fricción (retorno lento, sin rebote nervioso)
  var MAX_OFFSET    = 460;  // desplazamiento máximo
  var TAP_MS        = 260;  // click rápido = disparo
  var TAP_MOVE      = 8;    // px de tolerancia para considerarlo click
  var BLAST_RADIUS  = 190;
  var BLAST_FORCE   = 1500;
  var BLAST_RECOVER = 2.6;  // segundos hasta recuperar el resorte completo
  var JITTER_FORCE  = 9;    // jitter de los dígitos arrastrados
  var GRAB_RADIUS   = 72;   // radio para agarrar el dígito más cercano

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var edges = [
    { el: document.getElementById('edge-left'),  side: 'left'  },
    { el: document.getElementById('edge-right'), side: 'right' }
  ].filter(function (e) { return !!e.el; });

  if (!edges.length) return;

  var bits = [];

  var pointer = { x: -9999, y: -9999, active: false };
  var drag = null;
  var down = null;

  function build() {
    bits.length = 0;

    var count = Math.ceil((window.innerHeight + LINE_HEIGHT * 2) / LINE_HEIGHT);
    var lineHeight = LINE_HEIGHT;

    edges.forEach(function (edge) {
      edge.el.innerHTML = '';
      var frag = document.createDocumentFragment();
      var colWidth = edge.el.clientWidth / COLS;

      for (var col = 0; col < COLS; col++) {
        for (var i = 0; i < count; i++) {
          var span = document.createElement('span');
          span.className = 'bit';
          // Cada columna arranca en un punto distinto del patrón para
          // que las cuatro no queden idénticas, tejiendo una textura.
          span.textContent = PATTERN.charAt((i + col) % PATTERN.length);
          span.style.top = (i * lineHeight) + 'px';
          span.style.left = (col * colWidth) + 'px';
          span.style.width = colWidth + 'px';
          frag.appendChild(span);

          var bit = {
            el: span,
            index: i,
            col: col,
            x: 0, y: 0,
            vx: 0, vy: 0,
            homeX: 0, homeY: 0,
            rot: 0,
            pinned: false,
            spring: 1,
            recover: 0,
            phase: Math.random() * Math.PI * 2,
            speed: 0.25 + Math.random() * 0.35,
            side: edge.side,
            baseX: 0, baseY: 0
          };
          span.__bit = bit;
          bits.push(bit);
        }
      }

      edge.el.appendChild(frag);
    });

    measure();
  }

  function measure() {
    for (var i = 0; i < bits.length; i++) {
      var b = bits[i];
      var prev = b.el.style.transform;
      b.el.style.transform = 'none';
      var r = b.el.getBoundingClientRect();
      b.baseX = r.left + r.width / 2;
      b.baseY = r.top + r.height / 2;
      b.el.style.transform = prev;
    }
  }

  /* ---------------- Puntero ---------------- */

  function setPointer(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  }

  window.addEventListener('pointermove', function (e) {
    setPointer(e);
    if (drag) {
      drag.x = limitX(drag, e.clientX - drag.baseX);
      drag.y = limitY(drag, e.clientY - drag.baseY);
      drag.vx = 0;
      drag.vy = 0;
    }
    if (down) {
      down.moved = Math.max(
        down.moved,
        Math.hypot(e.clientX - down.x, e.clientY - down.y)
      );
    }
  }, { passive: true });

  window.addEventListener('pointerleave', function () {
    pointer.active = false;
    pointer.x = -9999;
    pointer.y = -9999;
  });

  // En touch, en cuanto el navegador toma el gesto como scroll de la
  // página deja de mandar pointermove para ese dedo (manda un
  // pointercancel y listo) — la repelencia se quedaría congelada donde
  // arrancó el scroll. touchmove sí se sigue disparando durante el
  // scroll nativo, así que la usamos en paralelo solo para actualizar
  // dónde está el dedo, sin tocar el scroll (todo pasivo).
  function setPointerFromTouch(e) {
    var t = e.touches && e.touches[0];
    if (!t) return;
    pointer.x = t.clientX;
    pointer.y = t.clientY;
    pointer.active = true;
  }

  window.addEventListener('touchstart', setPointerFromTouch, { passive: true });
  window.addEventListener('touchmove', setPointerFromTouch, { passive: true });

  window.addEventListener('touchend', function (e) {
    if (!drag && (!e.touches || !e.touches.length)) {
      pointer.active = false;
      pointer.x = -9999;
      pointer.y = -9999;
    }
  }, { passive: true });

  window.addEventListener('touchcancel', function () {
    if (!drag) {
      pointer.active = false;
      pointer.x = -9999;
      pointer.y = -9999;
    }
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) {
    setPointer(e);
    down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };

    // El dígito huye del cursor, así que si no hay impacto directo
    // se agarra el más cercano dentro de un radio corto.
    var target = e.target && e.target.classList &&
      e.target.classList.contains('bit') ? e.target.__bit : null;

    if (!target) target = nearestBit(e.clientX, e.clientY, GRAB_RADIUS);

    if (target && !reduceMotion) {
      drag = target;
      drag.el.classList.add('dragging');
      drag.dragged = false;
      if (e.target.setPointerCapture) {
        try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
      }
    }
  });

  window.addEventListener('pointerup', function (e) {
    var quick = down &&
      (performance.now() - down.t) < TAP_MS &&
      down.moved < TAP_MOVE;

    if (drag) {
      if (quick) {
        // Fue un click, no un arrastre: vuelve a su sitio
        drag.pinned = false;
        drag.homeX = 0;
        drag.homeY = 0;
      } else {
        // Se queda donde lo soltaste, con jitter lento
        drag.pinned = true;
        drag.homeX = drag.x;
        drag.homeY = drag.y;
      }
      drag.el.classList.remove('dragging');
      drag = null;
    }

    if (quick && !reduceMotion) blast(e.clientX, e.clientY);
    down = null;
  });

  window.addEventListener('pointercancel', function () {
    if (drag) {
      drag.el.classList.remove('dragging');
      drag = null;
    }
    down = null;
  });

  function nearestBit(px, py, radius) {
    var best = null;
    var bestD = radius;
    for (var i = 0; i < bits.length; i++) {
      var b = bits[i];
      var d = Math.hypot((b.baseX + b.x) - px, (b.baseY + b.y) - py);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  function blast(px, py) {
    for (var i = 0; i < bits.length; i++) {
      var b = bits[i];
      var dx = (b.baseX + b.x) - px;
      var dy = (b.baseY + b.y) - py;
      var d = Math.hypot(dx, dy);
      if (d > BLAST_RADIUS) continue;
      if (d < 0.001) { dx = 1; dy = 0; d = 1; }

      var f = (1 - d / BLAST_RADIUS) * BLAST_FORCE;
      b.vx += (dx / d) * f;
      b.vy += (dy / d) * f * 0.55;
      b.spring = 0.05;
      b.recover = BLAST_RECOVER;
    }
  }

  /* ---------------- Simulación ---------------- */

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  // Los dígitos huyen hacia adentro: nunca se van fuera de la pantalla.
  var EDGE_SLACK = 6;

  function limitX(b, x) {
    return b.side === 'left'
      ? clamp(x, -EDGE_SLACK, MAX_OFFSET)
      : clamp(x, -MAX_OFFSET, EDGE_SLACK);
  }

  function limitY(b, y) {
    var min = 10 - b.baseY;
    var max = (window.innerHeight - 10) - b.baseY;
    return clamp(y, Math.min(min, 0), Math.max(max, 0));
  }

  var last = performance.now();

  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    var t = now / 1000;

    for (var i = 0; i < bits.length; i++) {
      var b = bits[i];

      if (b === drag) {
        render(b);
        continue;
      }

      var ax = 0, ay = 0;

      // Repelencia del cursor / dedo
      if (pointer.active) {
        var dx = (b.baseX + b.x) - pointer.x;
        var dy = (b.baseY + b.y) - pointer.y;
        var d = Math.hypot(dx, dy);
        if (d < REPEL_RADIUS) {
          if (d < 0.001) { dx = 1; dy = 0.001; d = 1; }
          var falloff = 1 - d / REPEL_RADIUS;
          var f = falloff * falloff * REPEL_FORCE;
          // La columna se arquea hacia adentro y se abre en vertical.
          ax += (b.side === 'left' ? 1 : -1) * f * 0.8;
          ay += (dy / d) * f * 0.75;
        }
      }

      // Recuperación del resorte tras un disparo
      if (b.recover > 0) {
        b.recover -= dt;
        b.spring = 1 - Math.max(b.recover, 0) / BLAST_RECOVER * 0.95;
        if (b.recover <= 0) b.spring = 1;
      }

      // Jitter permanente de los dígitos arrastrados
      if (b.pinned) {
        ax += Math.sin(t * b.speed + b.phase) * JITTER_FORCE;
        ay += Math.cos(t * b.speed * 0.7 + b.phase * 1.7) * JITTER_FORCE;
      }

      // Resorte al lugar (propio u ocupado) + fricción
      ax += (b.homeX - b.x) * SPRING * b.spring;
      ay += (b.homeY - b.y) * SPRING * b.spring;
      ax -= b.vx * DAMPING;
      ay -= b.vy * DAMPING;

      b.vx += ax * dt;
      b.vy += ay * dt;

      var nx = limitX(b, b.x + b.vx * dt);
      var ny = limitY(b, b.y + b.vy * dt);
      if (nx !== b.x + b.vx * dt) b.vx *= -0.2;
      if (ny !== b.y + b.vy * dt) b.vy *= -0.2;
      b.x = nx;
      b.y = ny;

      render(b);
    }

    requestAnimationFrame(frame);
  }

  function render(b) {
    // La columna se curva: cada dígito se inclina según su propio desvío
    var target = clamp(b.x * 0.16, -32, 32);
    b.rot += (target - b.rot) * 0.15;

    b.el.style.transform =
      'translate3d(' + b.x.toFixed(2) + 'px,' + b.y.toFixed(2) + 'px,0) ' +
      'rotate(' + b.rot.toFixed(2) + 'deg)';
  }

  /* ---------------- Arranque ---------------- */

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(build, 180);
  });

  build();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(measure);
  }
  requestAnimationFrame(frame);
})();
