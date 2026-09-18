/* ---------------------------------------------------------------
   Las carpetas empiezan cerradas: solo se ve la pregunta. Tocar una
   la abre (se queda abierta, mostrando la respuesta) o la cierra si
   ya estaba abierta. Arrastrarla la reordena en la pila y, mientras
   se arrastra, también se ve su respuesta — al soltarla vuelve a su
   estado previo (abierta o cerrada).
----------------------------------------------------------------*/
(function () {
  'use strict';

  var MOVE_THRESHOLD = 6; // px antes de considerarlo un arrastre y no un tap

  var stack = document.querySelector('.folders__stack');
  if (!stack) return;

  var dragEl = null;
  var pointerId = null;
  var dragging = false;
  var startX = 0;
  var startY = 0;
  var grabOffsetY = 0; // distancia entre el dedo y el borde superior de la carpeta
  var desiredTop = 0;

  stack.addEventListener('pointerdown', function (e) {
    // Un link de la respuesta se maneja solo: ni drag ni toggle.
    if (e.target.closest('a')) return;

    var item = e.target.closest('.folder-tab');
    if (!item || dragEl) return;

    dragEl = item;
    pointerId = e.pointerId;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;

    var rect = item.getBoundingClientRect();
    grabOffsetY = e.clientY - rect.top;
  });

  window.addEventListener('pointermove', function (e) {
    if (!dragEl || e.pointerId !== pointerId) return;

    var dx = e.clientX - startX;
    var dy = e.clientY - startY;

    if (!dragging) {
      if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
      beginDrag();
    }

    e.preventDefault();
    desiredTop = e.clientY - grabOffsetY;
    placeAt(dragEl, desiredTop);
    checkSwaps();
  }, { passive: false });

  window.addEventListener('pointerup', function (e) {
    if (!dragEl || e.pointerId !== pointerId) return;
    endDrag();
  });

  window.addEventListener('pointercancel', function (e) {
    if (!dragEl || e.pointerId !== pointerId) return;
    endDrag();
  });

  function beginDrag() {
    dragging = true;
    dragEl.classList.add('folder-tab--dragging');
    dragEl.style.zIndex = 999;
    reveal(dragEl); // mientras se saca de la pila, se lee la respuesta
    try { dragEl.setPointerCapture(pointerId); } catch (err) {}
  }

  // Coloca el elemento en la posición vertical absoluta `top` (viewport),
  // sin sacarlo del flujo: se logra corriendo su transform respecto de
  // su posición natural actual (la que le toca según el orden del DOM).
  function placeAt(el, top) {
    el.style.transform = 'none';
    var naturalTop = el.getBoundingClientRect().top;
    el.style.transform = 'translateY(' + (top - naturalTop) + 'px)';
  }

  function items() {
    return Array.prototype.slice.call(stack.querySelectorAll('.folder-tab'));
  }

  function checkSwaps() {
    // Puede haber que saltar más de un vecino si el arrastre fue rápido.
    var moved = true;
    var guard = 0;
    while (moved && guard < 20) {
      moved = false;
      guard++;

      var list = items();
      var idx = list.indexOf(dragEl);
      var dragRect = dragEl.getBoundingClientRect();
      var dragCenter = dragRect.top + dragRect.height / 2;

      var next = list[idx + 1];
      if (next) {
        var nextRect = next.getBoundingClientRect();
        var nextCenter = nextRect.top + nextRect.height / 2;
        if (dragCenter > nextCenter) {
          flipMove(next, function () {
            stack.insertBefore(next, dragEl);
          });
          placeAt(dragEl, desiredTop);
          renumber();
          moved = true;
          continue;
        }
      }

      var prev = list[idx - 1];
      if (prev) {
        var prevRect = prev.getBoundingClientRect();
        var prevCenter = prevRect.top + prevRect.height / 2;
        if (dragCenter < prevCenter) {
          flipMove(prev, function () {
            stack.insertBefore(dragEl, prev);
          });
          placeAt(dragEl, desiredTop);
          renumber();
          moved = true;
        }
      }
    }
  }

  // Anima a `el` a su nueva posición después de que `mutate` cambie el DOM.
  function flipMove(el, mutate) {
    var first = el.getBoundingClientRect();
    mutate();
    var last = el.getBoundingClientRect();
    var delta = first.top - last.top;
    if (delta) {
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + delta + 'px)';
      requestAnimationFrame(function () {
        el.style.transition = 'transform 200ms ease';
        el.style.transform = '';
      });
    }
  }

  function renumber() {
    items().forEach(function (el, i) {
      if (el !== dragEl) el.style.setProperty('--z', i + 1);
    });
  }

  /* ---------------- Abrir / cerrar la respuesta ---------------- */

  function answerOf(card) {
    return card.querySelector('.folder-tab__answer');
  }

  function isOpen(card) {
    return card.classList.contains('folder-tab--open');
  }

  // Mide el alto real del contenido (sin el límite de max-height)
  // para poder animar hacia ese valor exacto en vez de adivinar uno.
  function naturalHeight(answer) {
    var prevMax = answer.style.maxHeight;
    var prevTransition = answer.style.transition;
    answer.style.transition = 'none';
    answer.style.maxHeight = 'none';
    var h = answer.scrollHeight;
    answer.style.maxHeight = prevMax;
    // Fuerza el reflow antes de restaurar la transición.
    void answer.offsetHeight;
    answer.style.transition = prevTransition;
    return h;
  }

  // Muestra la respuesta sin marcar la carpeta como "abierta" —
  // se usa mientras se arrastra, y se revierte sola al soltarla.
  function reveal(card) {
    var answer = answerOf(card);
    answer.style.maxHeight = naturalHeight(answer) + 'px';
    answer.removeAttribute('inert');
  }

  function setOpen(card, open) {
    var answer = answerOf(card);
    if (open) {
      card.classList.add('folder-tab--open');
      answer.style.maxHeight = naturalHeight(answer) + 'px';
      answer.removeAttribute('inert');
    } else {
      card.classList.remove('folder-tab--open');
      answer.style.maxHeight = '0px';
      answer.setAttribute('inert', '');
    }
  }

  function endDrag() {
    var wasDragging = dragging;
    var el = dragEl;

    dragEl = null;
    pointerId = null;
    dragging = false;

    if (!wasDragging) {
      // Fue un toque corto, no un arrastre: alterna abierta/cerrada.
      setOpen(el, !isOpen(el));
      return;
    }

    var list = items();
    var idx = list.indexOf(el);
    el.style.setProperty('--z', idx + 1);

    // Al sacar la clase vuelve a la transición base (altura + transform),
    // así se anima junta: la carpeta cae a su lugar en la pila.
    el.classList.remove('folder-tab--dragging');
    el.style.zIndex = '';
    el.style.transform = '';

    // Vuelve a mostrar u ocultar la respuesta según cómo estaba
    // antes de agarrarla (recalculando el alto por si cambió el layout).
    setOpen(el, isOpen(el));
  }
})();
