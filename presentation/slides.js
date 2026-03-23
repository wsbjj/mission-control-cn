(function() {
  var slides = document.querySelectorAll('.slide');
  var dots = document.getElementById('dots');
  var counter = document.getElementById('counter');
  var current = 0;
  var total = slides.length;

  // Build dots
  for (var i = 0; i < total; i++) {
    var dot = document.createElement('div');
    dot.className = 'nav-dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('data-i', i);
    dots.appendChild(dot);
  }

  function show(n) {
    if (n < 0 || n >= total || n === current) return;
    slides[current].classList.remove('active');
    current = n;
    slides[current].classList.add('active');
    var allDots = dots.querySelectorAll('.nav-dot');
    for (var j = 0; j < allDots.length; j++) {
      allDots[j].className = 'nav-dot' + (j === current ? ' active' : '');
    }
    counter.textContent = (current + 1) + ' / ' + total;
  }

  // Dot clicks
  dots.addEventListener('click', function(e) {
    var t = e.target;
    if (t.classList.contains('nav-dot')) {
      show(parseInt(t.getAttribute('data-i'), 10));
    }
  });

  // Prev / Next buttons
  document.getElementById('prevBtn').addEventListener('click', function(e) {
    e.stopPropagation();
    show(current - 1);
  });
  document.getElementById('nextBtn').addEventListener('click', function(e) {
    e.stopPropagation();
    show(current + 1);
  });

  // Keyboard
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); show(current + 1); }
    if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); show(current - 1); }
    if (e.key === 'Home') show(0);
    if (e.key === 'End') show(total - 1);
  });

  // Click anywhere (left third = back, rest = forward)
  document.addEventListener('click', function(e) {
    if (e.target.closest('#nav')) return;
    if (e.clientX < window.innerWidth * 0.33) { show(current - 1); }
    else { show(current + 1); }
  });

  // Touch swipe
  var sx = 0;
  document.addEventListener('touchstart', function(e) { sx = e.touches[0].clientX; }, {passive:true});
  document.addEventListener('touchend', function(e) {
    var dx = e.changedTouches[0].clientX - sx;
    if (dx < -50) show(current + 1);
    if (dx > 50) show(current - 1);
  }, {passive:true});
})();
