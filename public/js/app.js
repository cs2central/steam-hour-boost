// Hour Boost - Frontend JavaScript

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(data.error || 'Request failed');
    }
    return res.json();
  },

  async put(url, data) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(data.error || 'Request failed');
    }
    return res.json();
  },

  async delete(url) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(data.error || 'Request failed');
    }
    return res.json();
  },

  async upload(url, formData) {
    const res = await fetch(url, {
      method: 'POST',
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
  toast.innerHTML = `
    <div class="toast-content">
      ${type === 'success' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' : ''}
      ${type === 'error' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' : ''}
      ${type === 'info' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' : ''}
      <span>${message}</span>
    </div>
  `;

  // Add styles if not present
  if (!document.getElementById('toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
      .toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        padding: 12px 20px;
        border-radius: 8px;
        background: var(--bg-card);
        border: 1px solid var(--border-color);
        box-shadow: var(--shadow);
        z-index: 10000;
        animation: slideIn 0.3s ease;
      }
      .toast-content {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .toast svg {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }
      .toast-success { border-color: var(--success); }
      .toast-success svg { color: var(--success); }
      .toast-error { border-color: var(--error); }
      .toast-error svg { color: var(--error); }
      .toast-info { border-color: var(--accent); }
      .toast-info svg { color: var(--accent); }
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// Modal handling
function openModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// Close modal on escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }
});

// Logout function
function logout() {
  fetch('/api/logout', { method: 'POST' })
    .then(() => window.location.href = '/login');
}

// Format helpers
function formatTime(date) {
  return new Date(date).toLocaleTimeString();
}

function formatDate(date) {
  return new Date(date).toLocaleString();
}

// Common game names
const GAME_NAMES = {
  730: 'Counter-Strike 2',
  570: 'Dota 2',
  440: 'Team Fortress 2',
  252490: 'Rust',
  578080: 'PUBG',
  271590: 'GTA V',
  1172470: 'Apex Legends',
  252950: 'Rocket League',
  105600: 'Terraria',
  230410: 'Warframe',
  1085660: 'Destiny 2',
  892970: 'Valheim',
  1091500: 'Cyberpunk 2077',
  359550: 'Rainbow Six Siege'
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
