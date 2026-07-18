(function(){
  'use strict';
  var STORAGE_KEY = 'nwpuoj_sidebar_collapsed';
  var BREAKPOINT = 768;

  function isMobile() { return window.innerWidth <= BREAKPOINT; }

  function updateA11yState() {
    var button = document.querySelector('.nwpuoj-topbar-toggle');
    if (!button) return;
    var expanded = isMobile()
      ? document.body.classList.contains('nwpuoj-sidebar-mobile-open')
      : !document.body.classList.contains('nwpuoj-sidebar-collapsed');
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function applyCollapseState() {
    if (isMobile()) {
      document.documentElement.removeAttribute('data-nwpuoj-sidebar-collapsed');
      updateA11yState();
      return;
    }
    var collapsed = localStorage.getItem(STORAGE_KEY) === 'true';
    document.body.classList.toggle('nwpuoj-sidebar-collapsed', collapsed);
    if (collapsed) {
      document.documentElement.setAttribute('data-nwpuoj-sidebar-collapsed', 'true');
    } else {
      document.documentElement.removeAttribute('data-nwpuoj-sidebar-collapsed');
    }
    updateA11yState();
  }

  function toggleSidebar() {
    if (isMobile()) {
      document.body.classList.toggle('nwpuoj-sidebar-mobile-open');
    } else {
      var nowCollapsed = !document.body.classList.contains('nwpuoj-sidebar-collapsed');
      document.body.classList.toggle('nwpuoj-sidebar-collapsed', nowCollapsed);
      if (nowCollapsed) {
        document.documentElement.setAttribute('data-nwpuoj-sidebar-collapsed', 'true');
      } else {
        document.documentElement.removeAttribute('data-nwpuoj-sidebar-collapsed');
      }
      try { localStorage.setItem(STORAGE_KEY, nowCollapsed ? 'true' : 'false'); } catch (e) {}
    }
    updateA11yState();
  }

  function closeMobileSidebar() {
    document.body.classList.remove('nwpuoj-sidebar-mobile-open');
    updateA11yState();
  }

  function init() {
    applyCollapseState();
    document.documentElement.removeAttribute('data-nwpuoj-sidebar-initializing');
    var toggleBtn = document.querySelector('.nwpuoj-topbar-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function(e){ e.preventDefault(); toggleSidebar(); });
    }
    var backdrop = document.querySelector('.nwpuoj-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeMobileSidebar);
    // 手机端点导航项后自动关
    var items = document.querySelectorAll('.nwpuoj-sidebar-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function(){
        if (isMobile()) setTimeout(closeMobileSidebar, 100);
      });
    }
    // resize 处理
    var lastMobile = isMobile();
    window.addEventListener('resize', function(){
      var nowMobile = isMobile();
      if (nowMobile !== lastMobile) {
        lastMobile = nowMobile;
        if (nowMobile) {
          document.body.classList.remove('nwpuoj-sidebar-collapsed');
        } else {
          document.body.classList.remove('nwpuoj-sidebar-mobile-open');
          applyCollapseState();
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
