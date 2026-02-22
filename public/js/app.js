// Hour Boost - Frontend JavaScript

// HTML escape utility to prevent XSS
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

const API = {
  async get(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(data.error || 'Request failed');
    }
    return res.json();
  },

  async post(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(errData.error || 'Request failed');
    }
    return res.json();
  },

  async put(url, data) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(errData.error || 'Request failed');
    }
    return res.json();
  },

  async delete(url) {
    const res = await fetch(url, { method: 'DELETE', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(data.error || 'Request failed');
    }
    return res.json();
  },

  async upload(url, formData) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: formData
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(data.error || 'Request failed');
    }
    return res.json();
  }
};

// Toast notifications
function showToast(message, type = 'info') {
  // Remove existing toasts
  document.querySelectorAll('.toast').forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'assertive');
  toast.setAttribute('aria-atomic', 'true');
  toast.innerHTML = `
    <div class="toast-content">
      ${type === 'success' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' : ''}
      ${type === 'error' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' : ''}
      ${type === 'info' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' : ''}
      <span>${escapeHtml(message)}</span>
    </div>
  `;

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// Focus trap for modals - keeps Tab/Shift+Tab within the modal while open
function trapFocus(element) {
  const focusableEls = element.querySelectorAll('a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
  const firstFocusable = focusableEls[0];
  const lastFocusable = focusableEls[focusableEls.length - 1];

  function handleTab(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        lastFocusable.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        firstFocusable.focus();
        e.preventDefault();
      }
    }
  }

  element.addEventListener('keydown', handleTab);
  firstFocusable?.focus();
  return () => element.removeEventListener('keydown', handleTab);
}

// Track active focus trap cleanup functions and element that triggered the modal
const _modalState = {};

// Modal handling
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  // Store the element that triggered the modal so focus can be restored on close
  _modalState[modalId] = {
    trigger: document.activeElement,
    removeTrap: null
  };

  modal.classList.add('active');

  // Apply focus trap after the modal is visible
  const inner = modal.querySelector('.modal');
  if (inner) {
    _modalState[modalId].removeTrap = trapFocus(inner);
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.classList.remove('active');

  // Clean up focus trap and restore focus to the triggering element
  if (_modalState[modalId]) {
    if (_modalState[modalId].removeTrap) {
      _modalState[modalId].removeTrap();
    }
    const trigger = _modalState[modalId].trigger;
    if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
    delete _modalState[modalId];
  }
}

// Confirmation modal using the existing modal system
function confirmAction(message, onConfirm) {
  const modalId = 'confirm-modal';
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Confirm Action</h3>
          <button class="modal-close" onclick="closeModal('${modalId}')">&times;</button>
        </div>
        <div class="modal-body">
          <p id="confirm-message"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('${modalId}')">Cancel</button>
          <button class="btn btn-danger" id="confirm-action-btn">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  document.getElementById('confirm-message').textContent = message;
  const confirmBtn = document.getElementById('confirm-action-btn');
  const newBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
  newBtn.addEventListener('click', () => {
    closeModal(modalId);
    onConfirm();
  });
  openModal(modalId);
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    const modalId = e.target.id;
    if (modalId) {
      closeModal(modalId);
    } else {
      e.target.classList.remove('active');
    }
  }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => {
      if (m.id) {
        closeModal(m.id);
      } else {
        m.classList.remove('active');
      }
    });
  }
});

// Logout function
function logout() {
  fetch('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    .then(() => window.location.href = '/login');
}

// Format helpers
function formatTime(date) {
  return new Date(date).toLocaleTimeString();
}

function formatDate(date) {
  return new Date(date).toLocaleString();
}

// Common game names - single source of truth for all full game name lookups
const GAME_NAMES = {
  730: 'Counter-Strike 2',
  570: 'Dota 2',
  440: 'Team Fortress 2',
  252490: 'Rust',
  578080: 'PUBG',
  271590: 'GTA V',
  359550: 'Rainbow Six Siege',
  1172470: 'Apex Legends',
  1623730: 'Palworld',
  892970: 'Valheim',
  105600: 'Terraria',
  230410: 'Warframe',
  252950: 'Rocket League',
  1085660: 'Destiny 2',
  1091500: 'Cyberpunk 2077',
  493340: 'Planet Coaster',
  346110: 'ARK',
  3164500: 'Dark and Darker',
  428690: 'Fortnite',
  813780: 'Age of Empires II'
};

function getGameName(appId) {
  return GAME_NAMES[appId] || `Game ${appId}`;
}

// Steam persona states
const PERSONA_STATES = {
  0: { name: 'Offline', class: 'badge-muted' },
  1: { name: 'Online', class: 'badge-success' },
  2: { name: 'Busy', class: 'badge-error' },
  3: { name: 'Away', class: 'badge-warning' },
  4: { name: 'Snooze', class: 'badge-warning' },
  5: { name: 'Looking to Trade', class: 'badge-info' },
  6: { name: 'Looking to Play', class: 'badge-info' },
  7: { name: 'Invisible', class: 'badge-muted' }
};

// Scroll-to-top button
(function() {
  const btn = document.createElement('button');
  btn.className = 'scroll-top-btn';
  btn.setAttribute('aria-label', 'Scroll to top');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>';
  btn.addEventListener('click', function() {
    const main = document.querySelector('.main-content');
    if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.body.appendChild(btn);

  function checkScroll() {
    const main = document.querySelector('.main-content');
    const scrollTop = main ? main.scrollTop : (document.documentElement.scrollTop || document.body.scrollTop);
    btn.classList.toggle('visible', scrollTop > 300);
  }

  const main = document.querySelector('.main-content');
  if (main) main.addEventListener('scroll', checkScroll, { passive: true });
  window.addEventListener('scroll', checkScroll, { passive: true });
})();

// Form validation feedback - add visual feedback on invalid fields
document.addEventListener('invalid', function(e) {
  const el = e.target;
  if (el.classList.contains('form-control')) {
    el.style.borderColor = 'var(--error)';
    el.style.boxShadow = '0 0 0 3px rgba(248, 81, 73, 0.15)';
    el.addEventListener('input', function handler() {
      el.style.borderColor = '';
      el.style.boxShadow = '';
      el.removeEventListener('input', handler);
    });
  }
}, true);
