// ============================================================
//  CONFIGURACIÓN
// ============================================================
const STORAGE_KEY = 'xtraspilar_v22'; // no cambiar: es la clave donde ya hay datos guardados en este dispositivo
const DEBUG = false; // ← poné true solo si querés ver el overlay de depuración

// ============================================================
//  FIREBASE (login con Google + datos en la nube, separados por persona)
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyAPdRYdmuncIesZBYT3c-VK3W3XzFBL_ss",
    authDomain: "horax-e41c6.firebaseapp.com",
    projectId: "horax-e41c6",
    storageBucket: "horax-e41c6.firebasestorage.app",
    messagingSenderId: "440392502477",
    appId: "1:440392502477:web:64d4da1ef3ffa85b412d84"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
// Permite que la app siga andando sin internet: guarda una copia local
// de lo último sincronizado y lo manda apenas vuelve la conexión.
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    console.warn('[HORAX] Persistencia offline no disponible:', err.code);
});

let currentUser = null;
let userDocUnsubscribe = null;
let suppressNextSnapshot = false; // evita re-renderizar por nuestro propio guardado

function userDocRef(uid) { return db.collection('users').doc(uid); }

function showLoading(show) {
    const el = document.getElementById('appLoading');
    if (el) el.style.display = show ? 'flex' : 'none';
}
function showLoginScreen(show) {
    const login = document.getElementById('loginScreen');
    const app = document.getElementById('app');
    if (login) login.style.display = show ? 'flex' : 'none';
    if (app) app.style.display = show ? 'none' : 'flex';
}

async function handleSignedIn(user) {
    currentUser = user;
    showLoginScreen(false);
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = 'flex';

    userProfile = loadLocalProfile(user.uid); // lo que haya en este dispositivo, por si la nube tarda

    const ref = userDocRef(user.uid);
    try {
        const snap = await ref.get();
        if (snap.exists) {
            const data = snap.data() || {};
            overtimeData = data.entries || [];
            if (data.profile && data.profile.firstName) userProfile = data.profile;
        } else {
            // Primera vez que esta cuenta inicia sesión: si había datos guardados
            // en este mismo dispositivo (de antes del login), los subimos a la nube.
            loadData();
            await ref.set({ entries: overtimeData, email: user.email || null }, { merge: true });
        }
    } catch (err) {
        console.error('[HORAX] Error cargando datos:', err);
        loadData(); // como red de seguridad, mostramos lo que haya local
        showToast('No se pudo conectar a la nube, usando datos locales');
    }

    applyProfileToHeader();
    renderAll();
    showLoading(false);

    // Si todavía no eligió cómo llamarse, se lo pedimos antes de empezar.
    if (!userProfile || !userProfile.firstName) openProfileModal(true);

    if (userDocUnsubscribe) userDocUnsubscribe();
    userDocUnsubscribe = ref.onSnapshot(doc => {
        if (suppressNextSnapshot) { suppressNextSnapshot = false; return; }
        if (!doc.exists) return;
        const data = doc.data() || {};
        const remote = data.entries || [];
        if (data.profile && JSON.stringify(data.profile) !== JSON.stringify(userProfile)) {
            userProfile = data.profile;
            saveLocalProfile();
            applyProfileToHeader();
        }
        if (JSON.stringify(remote) !== JSON.stringify(overtimeData)) {
            overtimeData = remote;
            renderAll();
        }
    }, err => console.error('[HORAX] Error escuchando cambios:', err));
}

function handleSignedOut() {
    currentUser = null;
    userProfile = null;
    applyProfileToHeader();
    closeProfileModal(true);
    overtimeData = [];
    if (userDocUnsubscribe) { userDocUnsubscribe(); userDocUnsubscribe = null; }
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = 'none';
    showLoading(false);
    showLoginScreen(true);
}

// ============================================================
//  PERFIL DE LA PERSONA (nombre que se muestra en el header)
// ============================================================
let userProfile = null;
const PROFILE_KEY_PREFIX = 'horax_profile_';

// ---- Color de la app (uno por perfil) ----
const THEME_DEFAULT = '#6C63FF';
const THEME_COLORS = [
    { hex: '#6C63FF', name: 'Violeta' },
    { hex: '#FFF486', name: 'Amarillo' },
    { hex: '#F01D79', name: 'Fucsia' },
    { hex: '#FEC3E1', name: 'Rosa' },
    { hex: '#DAC2FE', name: 'Lila' },
    { hex: '#4CE5CF', name: 'Turquesa' },
    { hex: '#320016', name: 'Vino' }
];
const THEME_KEY = 'horax_theme';
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(c) { return '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase(); }
function mixRgb(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }
function relLum(c) {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function contrastRatio(l1, l2) { return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
// Texto que va encima del color: blanco u oscuro, el que se lea mejor
function onColorFor(hex) {
    const l = relLum(hexToRgb(hex));
    return contrastRatio(l, 1) >= 4.0 ? '#FFFFFF' : '#1A1A2E';
}
function applyTheme(hex) {
    const found = THEME_COLORS.find(c => c.hex.toLowerCase() === String(hex || '').toLowerCase());
    hex = found ? found.hex : THEME_DEFAULT;
    const rgb = hexToRgb(hex);
    const BLACK = [0, 0, 0], WHITE = [255, 255, 255];
    // versión legible como texto/ícono sobre fondo blanco (si el color es muy claro, se oscurece)
    let ink = rgb;
    for (let i = 1; i <= 20 && contrastRatio(relLum(ink), 1) < 4.2; i++) ink = mixRgb(rgb, BLACK, i * 0.05);
    const st = document.documentElement.style;
    st.setProperty('--primary', hex);
    st.setProperty('--primary-rgb', rgb.join(', '));
    st.setProperty('--primary-dark', rgbToHex(mixRgb(rgb, BLACK, 0.15)));
    st.setProperty('--primary-light', rgbToHex(mixRgb(rgb, WHITE, 0.2)));
    // fondo suave: si el color es muy claro, el tinte tiene que ser más fuerte para que se note
    st.setProperty('--primary-bg', rgbToHex(mixRgb(rgb, WHITE, relLum(rgb) > 0.5 ? 0.6 : 0.88)));
    st.setProperty('--primary-ink', rgbToHex(ink));
    st.setProperty('--primary-ink-light', rgbToHex(mixRgb(ink, WHITE, 0.25)));
    st.setProperty('--on-primary', onColorFor(hex));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', hex);
    try { localStorage.setItem(THEME_KEY, hex); } catch (_) {}
}
// Al abrir, usar el último color usado (evita el "salto" de color mientras carga el perfil)
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (_) {}
let pendingTheme = THEME_DEFAULT;
function renderThemeSwatches() {
    const box = document.getElementById('themeSwatches');
    if (!box) return;
    box.innerHTML = THEME_COLORS.map(c => {
        const sel = c.hex.toLowerCase() === pendingTheme.toLowerCase();
        return `<button type="button" class="theme-swatch ${sel ? 'sel' : ''}" data-hex="${c.hex}" style="background:${c.hex};" title="${c.name}" aria-label="${c.name}" aria-pressed="${sel}">${sel ? `<i class="fas fa-check" style="color:${onColorFor(c.hex)};"></i>` : ''}</button>`;
    }).join('');
    box.querySelectorAll('.theme-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            pendingTheme = btn.dataset.hex;
            applyTheme(pendingTheme); // vista previa en vivo
            renderThemeSwatches();
        });
    });
}

function loadLocalProfile(uid) {
    try {
        const raw = localStorage.getItem(PROFILE_KEY_PREFIX + uid);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && parsed.firstName ? parsed : null;
    } catch (_) { return null; }
}
function saveLocalProfile() {
    if (!currentUser) return;
    try {
        if (userProfile) localStorage.setItem(PROFILE_KEY_PREFIX + currentUser.uid, JSON.stringify(userProfile));
        else localStorage.removeItem(PROFILE_KEY_PREFIX + currentUser.uid);
    } catch (_) {}
}

function profileDisplayName() {
    if (!userProfile) return '';
    return [userProfile.firstName, userProfile.lastName].filter(Boolean).join(' ').trim();
}

function applyProfileToHeader() {
    applyTheme(userProfile && userProfile.themeColor);
    const name = profileDisplayName();
    const title = document.getElementById('headerTitle');
    const sub = document.getElementById('headerSubtitle');
    const chip = document.getElementById('profileChip');

    if (title) title.textContent = name || 'HORAX';
    if (sub) sub.style.display = name ? 'block' : 'none';
    if (chip) chip.title = name ? 'Mi perfil (nombre y color)' : 'HORAX';
}

function openProfileModal(firstTime) {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    const firstInput = document.getElementById('profileFirstName');
    const lastInput = document.getElementById('profileLastName');

    let first = (userProfile && userProfile.firstName) || '';
    let last = (userProfile && userProfile.lastName) || '';
    // La primera vez proponemos el nombre de la cuenta de Google, editable.
    if (!first && currentUser && currentUser.displayName) {
        const parts = currentUser.displayName.trim().split(/\s+/);
        first = parts.shift() || '';
        last = parts.join(' ');
    }
    firstInput.value = first;
    lastInput.value = last;
    pendingTheme = (userProfile && userProfile.themeColor) || THEME_DEFAULT;
    renderThemeSwatches();

    document.getElementById('profileModalTitle').innerHTML =
        `<i class="fas fa-id-badge" style="color:var(--primary-ink);margin-right:8px;"></i>` +
        (firstTime ? '¿Cómo te llamás?' : 'Mi perfil');
    document.getElementById('profileCancelBtn').style.display = firstTime ? 'none' : 'block';
    document.getElementById('profileError').style.display = 'none';
    modal.dataset.firstTime = firstTime ? '1' : '';
    modal.style.display = 'flex';
    setTimeout(() => firstInput.focus(), 120);
}

function closeProfileModal(force) {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    // Mientras no haya nombre cargado, el modal no se cierra tocando afuera.
    if (!force && modal.dataset.firstTime === '1') return;
    modal.style.display = 'none';
    modal.dataset.firstTime = '';
    // si se cerró sin guardar, volver al color del perfil (deshace la vista previa)
    applyTheme(userProfile && userProfile.themeColor);
}

function saveProfileFromModal() {
    const firstName = document.getElementById('profileFirstName').value.trim();
    const lastName = document.getElementById('profileLastName').value.trim();
    const errorEl = document.getElementById('profileError');
    if (!firstName) {
        errorEl.textContent = 'Escribí al menos tu nombre para continuar.';
        errorEl.style.display = 'block';
        return;
    }
    userProfile = { firstName, lastName, themeColor: pendingTheme };
    saveLocalProfile();
    applyProfileToHeader();
    closeProfileModal(true);
    showToast(`Listo, ${firstName}`);

    if (currentUser) {
        suppressNextSnapshot = true;
        userDocRef(currentUser.uid)
            .set({ profile: userProfile, email: currentUser.email || null }, { merge: true })
            .catch(err => {
                console.error('[HORAX] Error guardando el perfil:', err);
                showToast('El nombre quedó en este dispositivo, falta subirlo a la nube');
            });
    }
}

auth.onAuthStateChanged(user => {
    if (user) handleSignedIn(user);
    else handleSignedOut();
});

const COLOR_PALETTE = [
    '#B4A0E5','#FFF2CC','#A8E6A0','#0A2A5A','#F48FB1','#FFB86C','#6ECAC8',
    '#7C6EAD','#FFEB3B','#4DD0E1','#8D6E2F','#2E5A2E','#9AB8E8','#6B21A8',
    '#B5E8A0','#F28B82','#C8E6C9','#FF8A4D','#4A148C','#CE93D8','#80CBC4',
    '#F06292','#9575CD','#AED581','#FFD54F','#4DB6AC','#BA68C8','#E57373',
    '#64B5F6','#81C784','#FF7043','#A1887F','#90A4AE','#DCE775','#7986CB'
];
const employeeColorsCache = new Map();
function getEmployeeColor(person) {
    if (!person) return '#6C63FF';
    const key = person.toUpperCase();
    if (employeeColorsCache.has(key)) return employeeColorsCache.get(key);
    const idx = employeeColorsCache.size % COLOR_PALETTE.length;
    const color = COLOR_PALETTE[idx];
    employeeColorsCache.set(key, color);
    return color;
}

const NAME_STOPWORDS = new Set([
    'LIBRE','LIBRA','LIC','VERANO','CAP','COL','INT','PC','COSTA','MAT','AROCENA',
    'LUIS','KARLA','NUEVO','CENTRO','HORARIO','VAC','OFI','DES','DESC','DESCANSO',
    'EN','LA','EL','LOS','LAS','DE','DEL','POR','CON','Y','NC','PDE','HS',
    'LUNES','MARTES','MIERCOLES','MIÉRCOLES','JUEVES','VIERNES','SABADO','SÁBADO',
    'DOMINGO','SEPTIEMBRE','SETIEMBRE','OCTUBRE','AGOSTO','NOVIEMBRE','DICIEMBRE',
    'ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO'
]);

// Fecha de hoy según Montevideo (usa el reloj del celular, funciona sin internet)
function hoyMVD() {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date());
        const get = t => Number(parts.find(p => p.type === t).value);
        return { year: get('year'), month: get('month') - 1, day: get('day') };
    } catch (_) {
        const d = new Date();
        return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
    }
}
// "hoy" como Date local (mismo día/mes/año que en Montevideo)
function hoyDate() {
    const h = hoyMVD();
    return new Date(h.year, h.month, h.day);
}

function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function formatDateDisplay(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-ES',
        { day: 'numeric', month: 'long', year: 'numeric' });
}
function getDayName(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-ES', { weekday: 'long' });
}
const MONTH_MAP = {
    'enero':0,'febrero':1,'marzo':2,'abril':3,'mayo':4,'junio':5,
    'julio':6,'agosto':7,'septiembre':8,'setiembre':8,
    'octubre':9,'noviembre':10,'diciembre':11
};

// ============================================================
//  IMPORTAR DESDE FOTO (OCR) — configuración
//  A diferencia del PDF (que trae la posición exacta de cada
//  letra), de una foto hay que "leer" el texto con OCR. Estas
//  constantes calibran esa lectura para que las reglas de columnas/
//  filas/colores (pensadas para el PDF) también sirvan con fotos
//  de distinta resolución.
// ============================================================
const IMAGE_OCR_LANG = 'spa';
const IMAGE_MAX_DIMENSION = 2200; // baja fotos gigantes (más rápido, sin perder precisión real)
const IMAGE_REFERENCE_TEXT_HEIGHT = 8; // alto de letra "de referencia", en la misma escala que usa el PDF

// Rango horario real de la planilla (todas las semanas van de 5:00 a 23:00).
// Se usa tanto para el reparto parejo "de última" como para descartar anclas
// de hora que quedaron fuera de ese rango por un error de OCR.
const SCHEDULE_START_HOUR = 5;
const SCHEDULE_END_HOUR = 23;

let overtimeData = [];
let currentMonth = hoyMVD().month;
let currentYear = hoyMVD().year;
let selectedDate = null;
let currentTab = 'tabCalendar';
let pdfParsedData = null;

function loadData() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) { overtimeData = parsed; return true; }
        }
    } catch (_) {}
    return false;
}
function saveData() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overtimeData)); } catch (_) {}
    if (currentUser) {
        suppressNextSnapshot = true;
        userDocRef(currentUser.uid)
            .set({ entries: overtimeData, email: currentUser.email || null }, { merge: true })
            .catch(err => {
                console.error('[HORAX] Error guardando en la nube:', err);
                showToast('No se pudo guardar en la nube (sin conexión)');
            });
    }
    updateBadges();
}
function clearAllData() {
    if (!confirm('¿Borrar TODAS las extras? Esta acción no se puede deshacer.')) return;
    localStorage.removeItem(STORAGE_KEY);
    overtimeData = [];
    employeeColorsCache.clear();
    saveData(); renderAll(); showToast('Datos eliminados');
}

function getEntriesForDate(dateStr) { return overtimeData.filter(e => e.date === dateStr); }
function getEntriesForMonth(year, month) {
    const prefix = `${year}-${String(month+1).padStart(2,'0')}`;
    return overtimeData.filter(e => e.date.startsWith(prefix));
}
function getDatesWithOvertime(year, month) {
    const set = new Set();
    for (const e of getEntriesForMonth(year, month)) set.add(e.date);
    return set;
}
function getDayStatus(dateStr) {
    const entries = getEntriesForDate(dateStr);
    if (entries.length === 0) return 'none';
    return entries.every(e => e.done) ? 'done' : 'pending';
}
function getPeople() {
    const set = new Set();
    for (const e of overtimeData) set.add(e.person);
    return Array.from(set).sort((a,b) => a.localeCompare(b, 'es'));
}
function toggleDone(id) {
    const entry = overtimeData.find(e => e.id === id);
    if (entry) { entry.done = !entry.done; saveData(); renderAll(); }
}
function deleteEntry(id) {
    overtimeData = overtimeData.filter(e => e.id !== id);
    saveData(); renderAll(); showToast('Extra eliminada');
}
function addEntry(date, start, end, person) {
    const maxId = overtimeData.reduce((m, e) => Math.max(m, e.id), 0);
    overtimeData.push({ id: maxId + 1, date, start, end, person: person.trim(), done: false });
    saveData(); renderAll(); showToast(`Extra agregada para ${person}`);
}
function editEntry(id, date, start, end, person) {
    const entry = overtimeData.find(e => e.id === id);
    if (!entry) return;
    entry.date = date; entry.start = start; entry.end = end; entry.person = person.trim();
    saveData(); renderAll(); showToast('Extra actualizada');
}

let editingEntryId = null;
function openEditModal(id) {
    const entry = overtimeData.find(e => e.id === id);
    if (!entry) return;
    editingEntryId = id;
    document.getElementById('editDate').value = entry.date;
    document.getElementById('editStart').value = entry.start;
    document.getElementById('editEnd').value = entry.end;
    document.getElementById('editPerson').value = entry.person;
    document.getElementById('editModal').style.display = 'flex';
}
function closeEditModal() {
    editingEntryId = null;
    document.getElementById('editModal').style.display = 'none';
}
function saveEditFromModal() {
    if (editingEntryId == null) return;
    const date = document.getElementById('editDate').value;
    const start = document.getElementById('editStart').value;
    const end = document.getElementById('editEnd').value;
    const person = document.getElementById('editPerson').value.trim();
    if (!date || !start || !end || !person) { showToast('Completá todos los campos'); return; }
    if (start >= end) { showToast('El inicio debe ser anterior al final'); return; }
    editEntry(editingEntryId, date, start, end, person);
    selectedDate = date;
    closeEditModal();
}

function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const monthLabel = document.getElementById('monthLabel');
    const monthName = new Date(currentYear, currentMonth)
        .toLocaleDateString('es-ES', { month: 'long' });
    monthLabel.innerHTML = `${monthName.charAt(0).toUpperCase()+monthName.slice(1)} <small>${currentYear}</small>`;

    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const daysInPrev = new Date(currentYear, currentMonth, 0).getDate();
    const todayStr = formatDate(hoyDate());
    const datesWithOT = getDatesWithOvertime(currentYear, currentMonth);

    let html = '';
    for (const n of ['L','M','M','J','V','S','D']) html += `<div class="day-name">${n}</div>`;

    const startOffset = firstDay === 0 ? 6 : firstDay - 1;
    for (let i = startOffset - 1; i >= 0; i--) {
        const day = daysInPrev - i;
        const dateObj = new Date(currentYear, currentMonth - 1, day);
        html += `<button class="day-cell other-month" data-date="${formatDate(dateObj)}">${day}</button>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const dateObj = new Date(currentYear, currentMonth, d);
        const dateStr = formatDate(dateObj);
        const hasOT = datesWithOT.has(dateStr);
        const status = getDayStatus(dateStr);
        const isToday = dateStr === todayStr;
        const isSelected = dateStr === selectedDate;
        let cls = 'day-cell';
        if (isToday) cls += ' today';
        if (hasOT) cls += ' has-overtime';
        if (status === 'done') cls += ' done';
        else if (status === 'pending') cls += ' pending';
        if (isSelected) cls += ' selected';
        html += `<button class="${cls}" data-date="${dateStr}"><span class="day-number">${d}</span></button>`;
    }
    const totalCells = startOffset + daysInMonth;
    const remaining = (7 - (totalCells % 7)) % 7;
    for (let d = 1; d <= remaining; d++) {
        const dateObj = new Date(currentYear, currentMonth + 1, d);
        html += `<button class="day-cell other-month" data-date="${formatDate(dateObj)}">${d}</button>`;
    }
    grid.innerHTML = html;

    grid.querySelectorAll('.day-cell').forEach(el => {
        el.addEventListener('click', () => {
            const date = el.dataset.date;
            if (date) { selectedDate = date; renderCalendar(); }
        });
    });

    if (selectedDate) {
        const [sy, sm] = selectedDate.split('-').map(Number);
        if (sy !== currentYear || (sm - 1) !== currentMonth) {
            selectedDate = datesWithOT.size > 0 ? Array.from(datesWithOT).sort()[0] : null;
        }
    } else {
        if (datesWithOT.has(todayStr)) selectedDate = todayStr;
        else if (datesWithOT.size > 0) selectedDate = Array.from(datesWithOT).sort()[0];
    }
    renderDayDetail(selectedDate);
    updateBadges();
}

function renderDayDetail(dateStr) {
    const header = document.getElementById('detailDayName');
    const badge = document.getElementById('detailDateBadge');
    const content = document.getElementById('dayDetailContent');

    if (!dateStr) {
        header.textContent = 'Sin extras';
        badge.textContent = '—';
        content.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-plus"></i><p>No hay extras este mes</p></div>`;
        return;
    }
    const entries = getEntriesForDate(dateStr);
    const dayName = getDayName(dateStr);
    header.textContent = dayName.charAt(0).toUpperCase() + dayName.slice(1);
    badge.textContent = formatDateDisplay(dateStr);

    if (entries.length === 0) {
        content.innerHTML = `<div class="empty-state"><i class="fas fa-clock"></i><p>Sin extras este día</p></div>`;
        return;
    }
    const sorted = [...entries].sort((a,b) => a.start.localeCompare(b.start));
    let html = '';
    for (const e of sorted) {
        const color = getEmployeeColor(e.person);
        html += `
            <div class="ot-item ${e.done ? 'done' : ''}" data-id="${e.id}" style="border-left-color:${color};">
                <div class="ot-check ${e.done ? 'checked' : ''}" data-id="${e.id}">
                    ${e.done ? '<i class="fas fa-check"></i>' : ''}
                </div>
                <div class="ot-info">
                    <div class="ot-person" style="color:${color};">${e.person}</div>
                    <div class="ot-time">${e.start} - ${e.end}</div>
                </div>
                <button class="ot-edit" data-id="${e.id}"><i class="fas fa-pen"></i></button>
                <button class="ot-delete" data-id="${e.id}"><i class="fas fa-trash-alt"></i></button>
            </div>`;
    }
    content.innerHTML = html;

    content.querySelectorAll('.ot-check').forEach(el => {
        el.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleDone(parseInt(el.dataset.id, 10));
        });
    });
    content.querySelectorAll('.ot-edit').forEach(el => {
        el.addEventListener('click', ev => {
            ev.stopPropagation();
            openEditModal(parseInt(el.dataset.id, 10));
        });
    });
    content.querySelectorAll('.ot-delete').forEach(el => {
        el.addEventListener('click', ev => {
            ev.stopPropagation();
            const id = parseInt(el.dataset.id, 10);
            if (confirm('¿Eliminar esta extra?')) deleteEntry(id);
        });
    });
}

// ============================================================
//  RESUMEN: período de cierre del día 26 del mes anterior al día 25
//  (ej. Septiembre = 26 ago → 25 sep; el día 25 cuenta en el mes que cierra)
// ============================================================
const CIERRE_DIA = 25;
// Nota: el resumen ya no tiene mes propio; usa siempre currentMonth/currentYear
// (el mismo mes que está mostrando el Calendario) para que ambas secciones
// queden sincronizadas.

// A qué mes de cierre pertenece una fecha AAAA-MM-DD
function getClosingPeriodOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    let year = y, month = m - 1;
    if (d > CIERRE_DIA) { month++; if (month > 11) { month = 0; year++; } }
    return { year, month };
}

function getSummaryRange(year, month) {
    const startDate = new Date(year, month - 1, CIERRE_DIA + 1);
    const endDate = new Date(year, month, CIERRE_DIA);
    return { startDate, endDate, start: formatDate(startDate), end: formatDate(endDate) };
}
function getEntriesForSummary() {
    const r = getSummaryRange(currentYear, currentMonth);
    return overtimeData.filter(e => e.date >= r.start && e.date <= r.end);
}
function entryHours(e) {
    const [sh, sm] = e.start.split(':').map(Number);
    const [eh, em] = e.end.split(':').map(Number);
    return Math.max(0, ((eh * 60 + em) - (sh * 60 + sm)) / 60);
}
function fmtHours(h) { return String(Math.round(h * 100) / 100).replace('.', ','); }
function shiftSummary(delta) {
    currentMonth += delta;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    selectedDate = null;
    renderCalendar();
    renderSummary();
}

// Personas desplegadas en el Resumen
const expandedPeople = new Set();
let summaryRows = [];

function renderSummary() {
    summaryRows = [];
    const container = document.getElementById('summaryContainer');
    const range = getSummaryRange(currentYear, currentMonth);
    const monthName = new Date(currentYear, currentMonth, 1)
        .toLocaleDateString('es-ES', { month: 'long' });
    const fmtDay = d => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });

    let html = `
        <div class="month-nav">
            <button id="summaryPrev"><i class="fas fa-chevron-left"></i></button>
            <span class="month-label">${monthName.charAt(0).toUpperCase() + monthName.slice(1)} <small>${currentYear}</small></span>
            <button id="summaryNext"><i class="fas fa-chevron-right"></i></button>
        </div>
        <p style="text-align:center;font-size:12px;color:var(--text-light);margin:0 0 12px;">
            Del ${fmtDay(range.startDate)} al ${fmtDay(range.endDate)}
        </p>`;

    const entries = getEntriesForSummary();
    if (entries.length === 0) {
        html += `<div class="empty-state"><i class="fas fa-chart-simple"></i><p>No hay extras en este período</p></div>`;
    } else {
        const byPerson = new Map();
        for (const e of entries) {
            const p = byPerson.get(e.person) || { person: e.person, total: 0, done: 0, items: [] };
            p.items.push(e);
            const h = entryHours(e);
            p.total += h;
            if (e.done) p.done += h;
            byPerson.set(e.person, p);
        }
        const summary = Array.from(byPerson.values())
            .sort((a, b) => b.total - a.total || a.person.localeCompare(b.person, 'es'));

        summaryRows = summary;
        const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
        let sumTotal = 0, sumDone = 0;
        html += `<div class="summary-table"><table><thead><tr>
            <th>Persona</th><th>Horas</th><th>Hechas</th><th>Pendientes</th>
        </tr></thead><tbody>`;
        for (const row of summary) {
            sumTotal += row.total; sumDone += row.done;
            const color = getEmployeeColor(row.person);
            const idx = summary.indexOf(row);
            const open = expandedPeople.has(row.person);
            html += `<tr class="sum-row ${open ? 'open' : ''}" data-idx="${idx}">
                <td class="person-name" style="color:${color};"><i class="fas fa-chevron-right sum-arrow"></i>${row.person}</td>
                <td>${fmtHours(row.total)}</td>
                <td><span class="badge badge-done">${fmtHours(row.done)}</span></td>
                <td><span class="badge badge-pending">${fmtHours(row.total - row.done)}</span></td>
            </tr>`;
            const items = [...row.items].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
            html += `<tr class="sum-detail ${open ? 'open' : ''}" data-idx="${idx}"><td colspan="4"><div class="sum-detail-list">`;
            for (const e of items) {
                const day = Number(e.date.slice(8, 10));
                const mon = MESES[Number(e.date.slice(5, 7)) - 1];
                const wd = getDayName(e.date).slice(0, 3);
                html += `<div class="sum-detail-item ${e.done ? 'done' : ''}">
                    <span class="sd-date"><b>${day}</b> ${wd} · ${mon}</span>
                    <span class="sd-time">${e.start} – ${e.end}</span>
                    <span class="sd-h">${fmtHours(entryHours(e))} h</span>
                    <button class="sd-btn sd-check ${e.done ? 'checked' : ''}" data-id="${e.id}" title="${e.done ? 'Hecha' : 'Marcar como hecha'}">${e.done ? '<i class="fas fa-check"></i>' : ''}</button>
                    <button class="sd-btn sd-edit" data-id="${e.id}" title="Editar"><i class="fas fa-pen"></i></button>
                </div>`;
            }
            html += `</div></td></tr>`;
        }
        html += `<tr style="font-weight:700;">
                <td>Total</td>
                <td>${fmtHours(sumTotal)}</td>
                <td>${fmtHours(sumDone)}</td>
                <td>${fmtHours(sumTotal - sumDone)}</td>
            </tr>`;
        html += `</tbody></table></div>`;
    }
    container.innerHTML = html;

    // Tocar una persona para ver / ocultar su detalle
    container.querySelectorAll('.sum-row').forEach(tr => {
        tr.addEventListener('click', () => {
            const idx = tr.dataset.idx;
            const name = summaryRows[Number(idx)].person;
            const detail = container.querySelector(`.sum-detail[data-idx="${idx}"]`);
            const isOpen = tr.classList.toggle('open');
            if (detail) detail.classList.toggle('open', isOpen);
            if (isOpen) expandedPeople.add(name); else expandedPeople.delete(name);
        });
    });

    // Marcar hecha / editar desde el detalle del Resumen
    container.querySelectorAll('.sd-check').forEach(el => {
        el.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleDone(parseInt(el.dataset.id, 10));
        });
    });
    container.querySelectorAll('.sd-edit').forEach(el => {
        el.addEventListener('click', ev => {
            ev.stopPropagation();
            openEditModal(parseInt(el.dataset.id, 10));
        });
    });

    document.getElementById('summaryPrev').addEventListener('click', () => shiftSummary(-1));
    document.getElementById('summaryNext').addEventListener('click', () => shiftSummary(1));
}

function updateBadges() {
    const pendingHours = getEntriesForSummary()
        .filter(e => !e.done)
        .reduce((sum, e) => sum + entryHours(e), 0);
    const badge = document.getElementById('summaryBadge');
    if (!badge) return;
    if (pendingHours > 0) { badge.textContent = fmtHours(pendingHours); badge.style.display = 'flex'; }
    else badge.style.display = 'none';
}

function renderAll() {
    renderCalendar();
    renderSummary();
    const datalist = document.getElementById('personList');
    if (datalist) datalist.innerHTML = getPeople().map(p => `<option value="${p}">`).join('');
    updateBadges();
    renderUndoImport();
}

let toastTimeout = null;
function showToast(msg, ms = 2400) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.remove('show'), ms);
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    const t = document.getElementById(tabId); if (t) t.classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    const b = document.querySelector(`.tab-btn[data-tab="${tabId}"]`); if (b) b.classList.add('active');
    currentTab = tabId;
    if (tabId === 'tabSummary') renderSummary();
    if (tabId === 'tabCalendar') renderCalendar();
    const mc = document.getElementById('mainContent'); if (mc) mc.scrollTop = 0;
}

// ============================================================
//  UTILIDADES DE PDF
// ============================================================
function initPdfJs() {
    if (typeof pdfjsLib === 'undefined') {
        showToast('PDF.js no cargado.');
        return false;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return true;
}

function clusterByY(items, tolerance) {
    if (items.length === 0) return [];
    const sorted = [...items].sort((a, b) => a.y - b.y);
    const clusters = [];
    let current = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].y - sorted[i-1].y <= tolerance) current.push(sorted[i]);
        else { clusters.push(current); current = [sorted[i]]; }
    }
    clusters.push(current);
    return clusters;
}

// ============================================================
//  ★ CORREGIDO: mergeTextFragments
//  Antes: un único umbral horizontal de 4px pegaba nombres de
//  personas DISTINTAS que estaban cerca en la misma celda
//  (ej. "MARTI" + "GIM BEN" → "MARTI GIM" inventado, o directamente
//  se comía a una de las dos personas).
//  Ahora: paso 1 fusiona horizontal SOLO fragmentos casi pegados
//  (umbral 1px, para reconstruir un nombre partido en pedazos, no
//  para unir dos nombres distintos); paso 2 fusiona verticalmente
//  nombres que el PDF partió en 2 líneas dentro de la misma celda
//  (ej. "ROM" arriba y "LEO" justo debajo → "ROM LEO").
// ============================================================
// ★ CORREGIDO: los umbrales (en píxeles) estaban fijos y calibrados SOLO
// para el espacio de coordenadas del PDF (puntos de PDF, valores chicos:
// ~4-8px de alto de letra). Una foto se procesa en un canvas de hasta
// IMAGE_MAX_DIMENSION px, donde la misma letra mide 20-40px o más — con
// los umbrales viejos, la fusión de fragmentos partidos por el OCR
// prácticamente nunca se activaba en fotos (todo quedaba 3-5x más chico
// de lo necesario). Ahora los umbrales se escalan con geomScale, igual
// que el resto de los "números mágicos" del parser.
function mergeTextFragments(items, geomScale) {
    geomScale = geomScale || 1;
    // Paso 1: fusión horizontal, SOLO fragmentos casi pegados
    const yBucket = 4 * geomScale;
    const linesMap = new Map();
    for (const it of items) {
        const yKey = Math.round(it.y / yBucket);
        if (!linesMap.has(yKey)) linesMap.set(yKey, []);
        linesMap.get(yKey).push(it);
    }
    let merged = [];
    for (const group of linesMap.values()) {
        group.sort((a, b) => a.x - b.x);
        let current = null;
        for (const it of group) {
            if (current && (it.x - (current.x + current.width)) <= 1 * geomScale) {
                current.str += ' ' + it.str;
                current.width = (it.x + it.width) - current.x;
                current.height = Math.max(current.height, it.height);
            } else {
                if (current) merged.push(current);
                current = { str: it.str, x: it.x, y: it.y, width: it.width, height: it.height };
            }
        }
        if (current) merged.push(current);
    }

    // Paso 2: fusión vertical, para nombres partidos en 2 líneas
    // dentro de la misma celda (ej. "ROM" arriba y "LEO" debajo)
    merged.sort((a, b) => a.y - b.y || a.x - b.x);
    const used = new Array(merged.length).fill(false);
    const out = [];
    const dyMin = 1.5 * geomScale, dyMax = 5 * geomScale, dxMax = 3 * geomScale;
    for (let i = 0; i < merged.length; i++) {
        if (used[i]) continue;
        let cur = merged[i];
        for (let j = i + 1; j < merged.length; j++) {
            if (used[j]) continue;
            const cand = merged[j];
            const dy = cand.y - cur.y;
            if (dy < dyMin) continue;   // misma línea, ignorar
            if (dy > dyMax) break;      // ya muy lejos verticalmente, cortar
            const dx = Math.abs(cand.x - cur.x);
            // ★ CORREGIDO: si el texto es EXACTAMENTE igual al de arriba (ej. "CANDE"
            // repetido en cada fila de un bloque de varias horas), no es un nombre
            // partido en 2 líneas — es la MISMA persona en la fila de abajo. Fusionarlos
            // los convertía en 1 sola celda gigante y se perdían las horas de más abajo.
            const sameText = cand.str.trim().toUpperCase() === cur.str.trim().toUpperCase();
            if (dx <= dxMax && !sameText) {          // misma columna aprox. = 2da línea del mismo nombre
                cur = {
                    str: cur.str + ' ' + cand.str,
                    x: Math.min(cur.x, cand.x),
                    y: cand.y,
                    width: Math.max(cur.width, cand.width),
                    height: cur.height
                };
                used[j] = true;
            }
        }
        out.push(cur);
    }
    return out;
}

function isHeaderOrLabel(str) {
    if (!str) return true;
    const s = String(str).trim();
    if (!s) return true;
    if (MONTH_MAP[s.toLowerCase()] !== undefined) return true;
    if (/^(LUNES|MARTES|MI[EÉ]RCOLES|JUEVES|VIERNES|S[ÁA]BADO|DOMINGO)\b/i.test(s)) return true;
    if (/^\d{1,2}:\d{2}/.test(s)) return true;
    if (/^\d{1,2}$/.test(s)) return true;
    if (/^DES\b/i.test(s)) return true;
    return false;
}

function extractPersonName(text) {
    if (!text) return null;
    const tokens = String(text).split(/[\s,;\/]+/).filter(Boolean);
    const nameTokens = [];
    for (const raw of tokens) {
        const bare = raw.replace(/[.,;:!?]+$/, '').replace(/^[.,;:!?]+/, '');
        if (!bare) continue;
        if (/^\d/.test(bare)) break;
        const isUpperWord = /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ.]*$/.test(bare);
        if (isUpperWord) {
            const letters = bare.replace(/\./g, '');
            if (NAME_STOPWORDS.has(letters.toUpperCase())) {
                if (nameTokens.length > 0) break;
                continue;
            }
            if (letters.length >= 2 || (letters.length === 1 && nameTokens.length > 0)) {
                nameTokens.push(bare);
                if (nameTokens.length >= 2) break;
                continue;
            }
        }
        if (nameTokens.length > 0) break;
    }
    if (nameTokens.length === 0) return null;
    const name = nameTokens.join(' ').trim();
    if (name.length < 2 || name.length > 30) return null;
    return name;
}

// ============================================================
//  ★ NUEVO: CALIBRACIÓN DE FILAS POR HORAS "SUELTAS" (SOLO FOTOS)
//  Cuando una foto llega recortada y no trae la columna de "5:00 - 6:00 /
//  6:00 - 7:00 / ...", el único respaldo que había era repartir las horas
//  parejo de 5 a 23 en toda la altura de la imagen. El problema: si la
//  franja visible no arranca justo a las 5:00 (por cómo quedó recortada o
//  diseñada la captura), ese reparto se corre y las celdas caen en la fila
//  equivocada — o en ninguna — aunque el nombre y el color se hayan leído
//  perfecto.
//  Muchas fotos, sin embargo, ya traen la hora exacta pegada a algunos
//  nombres (ej. "PILAR 14:15", "CAMI O 22:15", "MARTI 14: 30") para marcar
//  que ese turno no arranca/termina en una hora redonda. Esas horas son
//  datos reales de la foto, no una estimación: sirven como "anclas"
//  (posición Y en la imagen ↔ hora real) para calcular la escala real de
//  esta captura puntual (píxeles por hora) y ubicar el resto de las filas
//  con mucha más precisión que un reparto uniforme "a ciegas".
// ============================================================

// Si el texto (ya fusionado por mergeTextFragments) termina en "H:MM" o
// "H: MM" (el OCR a veces deja un espacio antes de los minutos), devuelve
// esa hora como número decimal (14:30 → 14.5). Si no hay hora pegada al
// final, o no cae en el horario real de la planilla, devuelve null.
function extractTrailingTime(str) {
    const m = String(str).trim().match(/(\d{1,2})\s*:\s*(\d{2})\s*$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (mm < 0 || mm > 59) return null;
    if (h < SCHEDULE_START_HOUR || h > SCHEDULE_END_HOUR) return null;
    return h + mm / 60;
}

// Regresión lineal simple (mínimos cuadrados): hora = a·y + b
function linearRegression(points) {
    const n = points.length;
    if (n < 2) return null;
    let sumY = 0, sumH = 0, sumYH = 0, sumYY = 0;
    for (const p of points) {
        sumY += p.y; sumH += p.hour;
        sumYH += p.y * p.hour; sumYY += p.y * p.y;
    }
    const denom = n * sumYY - sumY * sumY;
    if (Math.abs(denom) < 1e-6) return null; // todas las anclas casi en la misma fila: no hay escala
    const a = (n * sumYH - sumY * sumH) / denom;
    const b = (sumH - a * sumY) / n;
    return { a, b };
}

// Busca, dentro del área de la grilla (no en encabezados), palabras que
// tengan nombre + hora pegada (ej. "PILAR 14:15") y arma la lista de anclas
// {y, hour}. Solo se usan como ancla las que también contienen un nombre de
// persona válido, para no confundir una hora suelta de una nota o de un
// encabezado con una celda real.
function collectTimeAnchors(words, colRanges, top, bottom) {
    const anchors = [];
    for (const w of words) {
        if (w.y < top || w.y > bottom) continue;
        if (isHeaderOrLabel(w.str)) continue;
        const wx = w.x + w.width / 2;
        let inGrid = false;
        for (const c of colRanges) {
            if (wx >= c.left && wx < c.right) { inGrid = true; break; }
        }
        if (!inGrid) continue;
        const hour = extractTrailingTime(w.str);
        if (hour == null) continue;
        if (!extractPersonName(w.str)) continue; // "14:15" sola, sin nombre, no sirve de ancla
        anchors.push({ y: w.y, hour });
    }
    return anchors;
}

// A partir de las anclas, calcula la recta (y → hora) y genera filas de 1h
// (mismo formato que las filas leídas de la columna de horarios) cubriendo
// toda el área visible. Si no hay anclas suficientes o confiables, devuelve
// null y el llamador cae al reparto parejo de siempre.
function buildCalibratedRowsFromEmbeddedTimes(words, colRanges, top, bottom, geomScale) {
    let pts = collectTimeAnchors(words, colRanges, top, bottom);
    if (pts.length < 2) return null;

    let reg = linearRegression(pts);
    if (!reg) return null;

    // Limpieza: saca anclas que no encajan en la recta (probable error de
    // OCR leyendo una hora que no es), y recalcula — máximo 2 pasadas.
    for (let pass = 0; pass < 2; pass++) {
        const before = pts.length;
        const cleaned = pts.filter(p => Math.abs((reg.a * p.y + reg.b) - p.hour) <= 1.5);
        if (cleaned.length < 2 || cleaned.length === before) break;
        const reg2 = linearRegression(cleaned);
        if (!reg2) break;
        pts = cleaned;
        reg = reg2;
    }

    if (pts.length < 2) return null;
    if (new Set(pts.map(p => p.hour)).size < 2) return null; // todas las anclas dicen la misma hora
    if (Math.abs(reg.a) < 1e-6) return null; // escala degenerada

    const hourAt = y => reg.a * y + reg.b;
    // margen de 1h de más para no perder la primera/última fila real que
    // haya quedado justo en el borde de lo visible
    let hStart = Math.floor(Math.min(hourAt(top), hourAt(bottom))) - 1;
    let hEnd = Math.ceil(Math.max(hourAt(top), hourAt(bottom))) + 1;
    hStart = Math.max(SCHEDULE_START_HOUR - 1, hStart);
    hEnd = Math.min(SCHEDULE_END_HOUR + 1, hEnd);
    if (hEnd - hStart < 2 || hEnd - hStart > (SCHEDULE_END_HOUR - SCHEDULE_START_HOUR) + 4) return null;

    const rows = [];
    for (let h = hStart; h < hEnd; h++) {
        const y = (h - reg.b) / reg.a;
        rows.push({
            start: `${String(h).padStart(2, '0')}:00`,
            end: `${String(h + 1).padStart(2, '0')}:00`,
            y
        });
    }
    rows.sort((r1, r2) => r1.y - r2.y);
    return rows;
}

function detectMonthFromTexts(textItems) {
    for (const it of textItems) {
        const s = String(it.str || '').toLowerCase();
        for (const name of Object.keys(MONTH_MAP)) {
            if (s.includes(name)) return name;
        }
    }
    return null; // sin nombre de mes en el archivo: quien llama usa el mes de hoy
}

async function renderPageToImageData(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;
    return {
        imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
        width: canvas.width,
        height: canvas.height,
        scale
    };
}

// ============================================================
//  ★ MUESTREO: BBOX DEL TEXTO (v17) con isGray AFINADO
// ============================================================
// ★ CORREGIDO: los umbrales de color estaban fijos ("hardcodeados") y
// calibrados EXCLUSIVAMENTE para los píxeles que renderiza pdf.js (colores
// planos, exactos, sin ruido). Una foto sacada con el celular nunca da esos
// valores exactos: el balance de blancos de la cámara, la luz ambiente, las
// sombras y la compresión JPEG corren el color gris real hacia tonos con
// algo de saturación (cálidos/fríos) y con brillo variable según la zona de
// la foto. Con el umbral viejo (sat<=8, lum 170-225) casi ninguna celda
// "gris" de una foto entraba en el rango → 0 horas extra detectadas, aunque
// el OCR haya leído bien el texto. Por eso ahora los umbrales son un
// parámetro (DEFAULT_COLOR_TOLERANCE para PDF, sin cambios de
// comportamiento; IMAGE_COLOR_TOLERANCE, más laxo, para fotos), pero el
// margen contra los colores fuertes de la planilla (sat >= 30) sigue siendo
// amplio, así que no se confunde una celda de color con una gris.
const DEFAULT_COLOR_TOLERANCE = {
    darkCutoff: 100, whiteCutoff: 248,
    whiteSatMax: 12, whiteLumMin: 228,
    graySatMax: 8, grayLumMin: 170, grayLumMax: 225,
    colorSatMin: 30
};
const IMAGE_COLOR_TOLERANCE = {
    darkCutoff: 55, whiteCutoff: 250,
    whiteSatMax: 20, whiteLumMin: 238,
    graySatMax: 24, grayLumMin: 80, grayLumMax: 246,
    colorSatMin: 32
};

function sampleTextBackground(imageData, xTopLeft, yTopLeft, w, h, tol) {
    tol = tol || DEFAULT_COLOR_TOLERANCE;
    const { width, height, data } = imageData;

    const x0 = Math.max(0, Math.floor(xTopLeft));
    const y0 = Math.max(0, Math.floor(yTopLeft));
    const x1 = Math.min(width - 1, Math.ceil(xTopLeft + w));
    const y1 = Math.min(height - 1, Math.ceil(yTopLeft + h));

    if (x1 - x0 < 2 || y1 - y0 < 2) return null;

    const samples = [];
    for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
            const idx = (py * width + px) * 4;
            const r = data[idx], g = data[idx+1], b = data[idx+2];
            const lum = (r + g + b) / 3;
            if (lum < tol.darkCutoff) continue;
            if (r > tol.whiteCutoff && g > tol.whiteCutoff && b > tol.whiteCutoff) continue;
            samples.push([r, g, b]);
        }
    }

    if (samples.length < 5) return null;

    const buckets = new Map();
    for (const [r, g, b] of samples) {
        const key = `${r >> 4}|${g >> 4}|${b >> 4}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push([r, g, b]);
    }
    let bestList = null;
    for (const list of buckets.values()) {
        if (!bestList || list.length > bestList.length) bestList = list;
    }

    let rSum = 0, gSum = 0, bSum = 0;
    for (const [r, g, b] of bestList) { rSum += r; gSum += g; bSum += b; }
    const r = rSum / bestList.length;
    const g = gSum / bestList.length;
    const b = bSum / bestList.length;

    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC - minC;
    const lum = (r + g + b) / 3;
    const coverage = bestList.length / samples.length;

    const isWhite = sat < tol.whiteSatMax && lum > tol.whiteLumMin;
    const isGray = sat <= tol.graySatMax && lum >= tol.grayLumMin && lum <= tol.grayLumMax;
    const isColor = sat >= tol.colorSatMin;

    return {
        r, g, b, sat, lum, coverage,
        totalSamples: samples.length,
        bucketSize: bestList.length,
        isWhite, isGray, isColor
    };
}

// ============================================================
//  DEBUG OVERLAY
// ============================================================
async function drawDebugOverlay(page, pageNum, zones, extras) {
    const scale = 1.5;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.zIndex = '9999';
    canvas.style.background = 'white';
    canvas.style.border = '4px solid red';
    canvas.style.maxWidth = '100vw';
    canvas.style.maxHeight = '100vh';
    canvas.style.objectFit = 'contain';
    canvas.style.cursor = 'pointer';
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    ctx.strokeStyle = '#FF0000';
    ctx.lineWidth = 1.5;
    for (const z of zones) {
        ctx.strokeRect(
            z.left * scale, z.top * scale,
            (z.right - z.left) * scale, (z.bottom - z.top) * scale
        );
        ctx.fillStyle = z.isGray ? 'rgba(255,0,255,0.15)' : 'rgba(0,200,0,0.05)';
        ctx.fillRect(
            z.left * scale, z.top * scale,
            (z.right - z.left) * scale, (z.bottom - z.top) * scale
        );
        ctx.fillStyle = 'black';
        ctx.font = '11px monospace';
        const tag = z.isGray ? `GRAY rgb(${z.r|0},${z.g|0},${z.b|0})` : `color rgb(${z.r|0},${z.g|0},${z.b|0})`;
        ctx.fillText(tag, z.left * scale + 4, z.top * scale + 14);
        if (z.name) {
            ctx.fillStyle = z.isGray ? 'red' : 'blue';
            ctx.fillText(z.name, z.left * scale + 4, z.top * scale + 28);
        }
    }

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(10, 10, 500, 60);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`DEBUG página ${pageNum} — click para cerrar`, 20, 30);
    ctx.font = '12px sans-serif';
    ctx.fillText(`Verde = color (regular), Magenta = gris (extra). Total: ${extras.length} extras`, 20, 55);

    canvas.addEventListener('click', () => canvas.remove());
    document.body.appendChild(canvas);
    console.log(`[DEBUG] Overlay dibujado para página ${pageNum}`);
}

// ============================================================
//  DETECCIÓN DE CABECERAS DE DÍA ("LUNES 15")
//  En el PDF, el nombre del día y el número suelen venir ya
//  pegados en un solo texto ("LUNES 15"). En una foto leída por
//  OCR casi siempre quedan como dos palabras separadas ("LUNES"
//  y "15" una al lado de la otra) — por eso se prueban los dos
//  casos.
// ============================================================
function findDayHeaders(words, maxGap) {
    const DAY_RE = /^(LUNES|MARTES|MI[EÉ]RCOLES|JUEVES|VIERNES|S[ÁA]BADO|DOMINGO)\b/;
    const onlyDayNameRe = new RegExp('^' + DAY_RE.source.slice(1) + '\\.?$');
    const headers = [];
    const usedAsNumber = new Set();

    // Caso 1: nombre y número pegados en la misma palabra ("LUNES 15", típico del PDF)
    for (const w of words) {
        const s = w.str.toUpperCase().trim();
        const together = s.match(new RegExp(DAY_RE.source + '\\s+(\\d{1,2})\\b'));
        if (together) {
            const day = parseInt(together[2], 10);
            if (day >= 1 && day <= 31) headers.push({ day, x: w.x + w.width / 2, y: w.y, text: w.str });
        }
    }

    // Caso 2: nombre y número en palabras separadas ("LUNES" ... "15", típico de OCR).
    // ★ Ojo: NO se puede asumir que el número aparece DESPUÉS del nombre en un
    // orden por (y, x) — dos palabras de la misma línea pueden diferir en 1px
    // de alto (OCR) y terminar en "filas" distintas al ordenar, lo que antes
    // hacía que se saltee la pareja (ej. "JUEVES"+"10" nunca se emparejaban
    // aunque "SABADO"+"12" sí, en la misma imagen). Por eso ahora se busca,
    // para cada nombre de día suelto, el número más cercano en TODA la lista
    // de palabras, sin depender del orden en que quedaron ordenadas.
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const s = w.str.toUpperCase().trim();
        if (!onlyDayNameRe.test(s)) continue;

        let bestJ = -1, bestGap = Infinity;
        for (let j = 0; j < words.length; j++) {
            if (j === i || usedAsNumber.has(j)) continue;
            const w2 = words[j];
            if (Math.abs(w2.y - w.y) > (w.height || 10) * 1.2) continue;
            if (w2.x < w.x) continue;
            const gap = w2.x - (w.x + w.width);
            if (gap > maxGap) continue;
            if (!/^\d{1,2}$/.test(w2.str.trim())) continue;
            if (gap < bestGap) { bestGap = gap; bestJ = j; }
        }
        if (bestJ === -1) continue;
        const w2 = words[bestJ];
        const day = parseInt(w2.str.trim(), 10);
        if (day >= 1 && day <= 31) {
            headers.push({ day, x: (w.x + w2.x + w2.width) / 2, y: w.y, text: `${w.str} ${w2.str}` });
            usedAsNumber.add(bestJ);
        }
    }
    return headers;
}

// ============================================================
//  EXTRACCIÓN COMPARTIDA (PDF y foto usan la misma lógica)
//  Recibe:
//   - rawItems: texto detectado (PDF: texto real; foto: palabras del OCR), sin fusionar
//   - imageData: los píxeles donde muestrear el color de fondo de cada celda
//   - colorScale: cuánto hay que multiplicar las coordenadas de rawItems para
//     caer en el mismo espacio de píxeles que imageData
//   - geomScale: cuánto más "grandes" son las coordenadas de rawItems respecto
//     a las que se usaron para calibrar los números mágicos de abajo (en el
//     PDF es 1; en una foto depende de la resolución y el tamaño de letra)
//   - baseMonth / monthState: para reconocer a qué mes pertenece cada columna
// ============================================================
function extractEntriesFromSource(rawItems, imageData, colorScale, geomScale, baseMonth, monthState, fixedTextHeight, synthesizeRowsIfMissing, colorTolerance, detectMissingGrayCells) {
    const dbg = { weekGroups: 0, cols: 0, rows: 0, cells: 0, grayCells: 0, syntheticRows: false, calibratedRows: false };
    const entries = [];
    const zones = []; // solo se usa si DEBUG === true, para dibujar el overlay
    // ★ NUEVO (solo fotos): celdas de la grilla cuyo FONDO es gris (=hora
    // extra) pero a las que ningún nombre quedó asociado en esta pasada de
    // OCR. Se llenan más abajo, barriendo la grilla por color en vez de por
    // texto — así no dependen de que el OCR haya encontrado la palabra.
    const missingGrayCells = [];

    const words = mergeTextFragments(rawItems, geomScale);
    const dayHeaders = findDayHeaders(words, 25 * geomScale);

    const sortedHeaders = [...dayHeaders].sort((a, b) => a.y - b.y || a.x - b.x);
    let runningMonth = (monthState.lastGlobalDay > 0) ? monthState.globalMonth : baseMonth;
    let runningYear = monthState.globalYear;
    let lastDay = monthState.lastGlobalDay;
    for (const h of sortedHeaders) {
        if (lastDay === 0) {
            if (h.day > 20) {
                runningMonth = baseMonth - 1;
                if (runningMonth < 0) { runningMonth = 11; runningYear--; }
            } else { runningMonth = baseMonth; }
        } else if (h.day < lastDay - 5) {
            runningMonth++;
            if (runningMonth > 11) { runningMonth = 0; runningYear++; }
        }
        h.month = runningMonth;
        h.year = runningYear;
        lastDay = h.day;
    }
    if (sortedHeaders.length > 0) {
        monthState.lastGlobalDay = lastDay;
        monthState.globalMonth = runningMonth;
        monthState.globalYear = runningYear;
    }

    const weekGroups = clusterByY(dayHeaders, 150 * geomScale);
    dbg.weekGroups += weekGroups.length;

    for (let wg = 0; wg < weekGroups.length; wg++) {
        const group = weekGroups[wg];
        const groupSorted = [...group].sort((a, b) => a.x - b.x);
        // antes pedía al menos 5 columnas (asumía que siempre venía la semana completa).
        // Una foto puede venir recortada a solo 2, 3 o 4 días — con 2 alcanza para calcular
        // el ancho de cada columna (por diferencia con la columna vecina).
        if (groupSorted.length < 2) continue;

        const weekTopY = Math.min(...group.map(h => h.y));
        const weekBottomY = (wg < weekGroups.length - 1)
            ? Math.min(...weekGroups[wg + 1].map(h => h.y)) - 30 * geomScale
            : (imageData.height / colorScale);
        const weekContentTop = weekTopY + 20 * geomScale;
        const noteTopY = weekTopY + 30 * geomScale;

        const colRanges = [];
        for (let i = 0; i < groupSorted.length; i++) {
            const h = groupSorted[i];
            let left, right;
            if (i === 0) {
                const nextX = groupSorted[i + 1].x;
                const gap = nextX - h.x;
                left = h.x - gap * 0.5;
                right = h.x + gap * 0.5;
            } else if (i === groupSorted.length - 1) {
                const prevX = groupSorted[i - 1].x;
                const gap = h.x - prevX;
                left = h.x - gap * 0.5;
                right = h.x + gap * 0.5;
            } else {
                const prevX = groupSorted[i - 1].x;
                const nextX = groupSorted[i + 1].x;
                left = (prevX + h.x) / 2;
                right = (h.x + nextX) / 2;
            }
            colRanges.push({ day: h.day, month: h.month, year: h.year, headerX: h.x, headerY: h.y, left, right });
        }
        dbg.cols += colRanges.length;

        const firstColLeft = colRanges[0].left;
        const timeWords = words.filter(w => {
            if (w.x + w.width > firstColLeft - 5 * geomScale) return false;
            if (w.y < weekContentTop || w.y > weekBottomY) return false;
            return /^\d{1,2}:\d{2}/.test(w.str);
        });

        const timeRows = [];
        for (const tw of timeWords) {
            const m = tw.str.match(/^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/);
            if (!m) continue;
            timeRows.push({
                start: `${m[1].padStart(2, '0')}:${m[2]}`,
                end: `${m[3].padStart(2, '0')}:${m[4]}`,
                y: tw.y
            });
        }
        timeRows.sort((a, b) => a.y - b.y);

        const uniqueRows = [];
        for (const tr of timeRows) {
            if (uniqueRows.length === 0 || uniqueRows[uniqueRows.length - 1].start !== tr.start) {
                uniqueRows.push(tr);
            }
        }

        // ★ RESPALDO, PASO 1 — CALIBRAR CON LAS HORAS QUE YA VIENEN PEGADAS A
        // ALGUNOS NOMBRES (ej. "PILAR 14:15", "CAMI O 22:15", "MARTI 14: 30").
        // Cuando la foto no trae la columna de "5:00 - 6:00 / 6:00 - 7:00 /..."
        // (pasa cuando alguien recorta la foto justo al lado de los días), antes
        // de resignarnos a repartir las horas "a ojo" y parejo, buscamos esas
        // horas sueltas que YA están en la propia celda: son datos reales de
        // la foto, no una estimación. Con al menos dos de esas horas, en
        // posiciones Y distintas, se puede calcular la escala real (píxeles
        // por hora) de esta captura puntual y ubicar todas las filas con mucha
        // más precisión que un reparto uniforme — sin tocar en nada la lectura
        // del PDF (esto solo corre cuando ya falló encontrar la columna de
        // horarios, y solo para fotos: synthesizeRowsIfMissing es false en PDF).
        if (uniqueRows.length === 0 && synthesizeRowsIfMissing) {
            const calibrated = buildCalibratedRowsFromEmbeddedTimes(
                words, colRanges, weekContentTop, weekBottomY, geomScale
            );
            if (calibrated) {
                uniqueRows.push(...calibrated);
                dbg.calibratedRows = true;
            }
        }

        // ★ RESPALDO, PASO 2 — si tampoco hay horas sueltas para calibrar
        // (ninguna celda trae un horario pegado al nombre), no queda otra
        // forma de saber a qué hora corresponde cada fila... salvo que esta
        // planilla SIEMPRE va de 5:00 a 23:00, en filas parejas de 1 hora
        // (18 filas en total). Se arma esa grilla estándar repartiendo parejo
        // el alto de la columna. Es el último recurso: no es tan preciso como
        // leer la hora real, pero es mucho mejor que no leer nada.
        if (uniqueRows.length === 0 && synthesizeRowsIfMissing) {
            const totalRows = SCHEDULE_END_HOUR - SCHEDULE_START_HOUR;
            const rowH = (weekBottomY - weekContentTop) / totalRows;
            if (rowH > 0) {
                for (let i = 0; i < totalRows; i++) {
                    const h = SCHEDULE_START_HOUR + i;
                    uniqueRows.push({
                        start: `${String(h).padStart(2, '0')}:00`,
                        end: `${String(h + 1).padStart(2, '0')}:00`,
                        y: weekContentTop + rowH * (i + 0.5)
                    });
                }
                dbg.syntheticRows = true;
            }
        }

        dbg.rows += uniqueRows.length;

        const rowRanges = [];
        for (let i = 0; i < uniqueRows.length; i++) {
            const r = uniqueRows[i];
            let top, bottom;
            if (i === 0) {
                const nextY = uniqueRows[i + 1]?.y ?? r.y + 20 * geomScale;
                const gap = nextY - r.y;
                top = r.y - gap * 0.5;
                bottom = r.y + gap * 0.5;
            } else if (i === uniqueRows.length - 1) {
                const prevY = uniqueRows[i - 1].y;
                const gap = r.y - prevY;
                top = r.y - gap * 0.5;
                bottom = r.y + gap * 0.5;
            } else {
                const prevY = uniqueRows[i - 1].y;
                const nextY = uniqueRows[i + 1].y;
                top = (prevY + r.y) / 2;
                bottom = (r.y + nextY) / 2;
            }
            rowRanges.push({ start: r.start, end: r.end, labelY: r.y, top, bottom });
        }

        const matchedInGroup = new Set(); // "fecha|horaInicio" ya cubiertos por un nombre leído

        for (const w of words) {
            if (isHeaderOrLabel(w.str)) continue;
            if (w.y < noteTopY || w.y > weekBottomY) continue;

            const wx = w.x + w.width / 2;
            let col = null;
            for (const c of colRanges) {
                if (wx >= c.left && wx < c.right) { col = c; break; }
            }
            if (!col) continue;

            const rowY = w.y + 2.85 * geomScale;
            let row = null;
            for (const r of rowRanges) {
                if (rowY >= r.top && rowY < r.bottom) { row = r; break; }
            }
            if (!row) continue;

            const name = extractPersonName(w.str);
            if (!name) continue;

            const textW = w.width || 30 * geomScale;
            // PDF: alto fijo (no depende de la versión de PDF.js, ver nota histórica más abajo).
            // Foto: se usa el alto real que midió el OCR para esa palabra, que es confiable.
            const textH = (fixedTextHeight != null) ? fixedTextHeight : (w.height || 4 * geomScale);
            const bboxX = w.x * colorScale;
            const bboxY = (w.y - textH) * colorScale;
            const bboxW = textW * colorScale;
            const bboxH = textH * colorScale;

            const colorInfo = sampleTextBackground(imageData, bboxX, bboxY, bboxW, bboxH, colorTolerance);
            dbg.cells++;

            if (DEBUG && colorInfo) {
                zones.push({
                    left: col.left, right: col.right, top: row.top, bottom: row.bottom,
                    isGray: colorInfo.isGray, r: colorInfo.r, g: colorInfo.g, b: colorInfo.b,
                    name, day: col.day, hour: row.start
                });
            }

            if (!colorInfo || !colorInfo.isGray) continue;
            dbg.grayCells++;

            const dateStr = formatDate(new Date(col.year, col.month, col.day));
            matchedInGroup.add(`${dateStr}|${row.start}`);
            entries.push({ date: dateStr, start: row.start, end: row.end, person: name, done: false });
        }

        // ★ NUEVO: segundo barrido de la MISMA grilla, esta vez por COLOR de
        // celda entera (no por palabra encontrada). Cualquier celda gris que
        // haya quedado sin nombre asociado es sospechosa de ser una hora extra
        // que el OCR no pudo leer (letra chica/bajo contraste) — se guarda
        // para intentar releerla puntualmente con zoom (solo aplica a fotos).
        if (detectMissingGrayCells && colRanges.length && rowRanges.length) {
            const colW = colRanges[0].right - colRanges[0].left;
            const marginX = Math.max(1, colW * 0.1);
            for (const col of colRanges) {
                const dateStr = formatDate(new Date(col.year, col.month, col.day));
                for (const row of rowRanges) {
                    if (matchedInGroup.has(`${dateStr}|${row.start}`)) continue;
                    const rowH = row.bottom - row.top;
                    const left = col.left + marginX, right = col.right - marginX;
                    const top = row.top + rowH * 0.08, bottom = row.bottom - rowH * 0.08;
                    if (right - left < 4 || bottom - top < 4) continue;
                    const colorInfo = sampleTextBackground(
                        imageData, left * colorScale, top * colorScale,
                        (right - left) * colorScale, (bottom - top) * colorScale, colorTolerance
                    );
                    if (!colorInfo || !colorInfo.isGray) continue;
                    missingGrayCells.push({ left, right, top, bottom, date: dateStr, start: row.start, end: row.end });
                }
            }
        }
    }

    return { entries, dbg, zones, missingGrayCells };
}

// ============================================================
//  PARSER PRINCIPAL (PDF)
// ============================================================
async function parsePdfFile(file) {
    if (!initPdfJs()) return;

    const reader = new FileReader();
    reader.onload = async function (e) {
        const dbg = { pages: 0, weekGroups: 0, cols: 0, rows: 0, cells: 0, grayCells: 0 };
        try {
            const pdf = await pdfjsLib.getDocument({ data: e.target.result }).promise;
            const allEntries = [];
            let lastGlobalDay = 0;
            let globalMonth = hoyMVD().month;
            // el año sale del nombre del archivo (ej. HORARIOS_2026_-_SEPTIEMBRE...); si no lo trae, el año actual
            const yearInName = String((file && file.name) || '').match(/20\d{2}/);
            let globalYear = yearInName ? parseInt(yearInName[0], 10) : hoyMVD().year;

            for (let p = 1; p <= pdf.numPages; p++) {
                dbg.pages++;
                const page = await pdf.getPage(p);
                const viewport = page.getViewport({ scale: 1 });
                const textContent = await page.getTextContent();

                const items = [];
                for (const it of textContent.items) {
                    const s = String(it.str || '').trim();
                    if (!s) continue;
                    // ignorar texto girado (los "LIBRA ..." verticales entre días)
                    if (Math.abs(it.transform[1]) > 0.5 || Math.abs(it.transform[2]) > 0.5) continue;
                    const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
                    items.push({
                        str: s, x: vx, y: vy,
                        width: it.width || 0, height: it.height || 8
                    });
                }
                if (items.length === 0) continue;

                const SCALE = 2;
                const rendered = await renderPageToImageData(page, SCALE);

                const detectedMonthName = detectMonthFromTexts(items);
                const baseMonth = MONTH_MAP[detectedMonthName] ?? hoyMVD().month;

                const monthState = { lastGlobalDay, globalMonth, globalYear };
                const result = extractEntriesFromSource(
                    items, rendered.imageData, SCALE, /* geomScale */ 1, baseMonth, monthState, /* fixedTextHeight */ 4,
                    /* synthesizeRowsIfMissing */ false, /* colorTolerance */ DEFAULT_COLOR_TOLERANCE
                );
                lastGlobalDay = monthState.lastGlobalDay;
                globalMonth = monthState.globalMonth;
                globalYear = monthState.globalYear;

                allEntries.push(...result.entries);
                dbg.weekGroups += result.dbg.weekGroups;
                dbg.cols += result.dbg.cols;
                dbg.rows += result.dbg.rows;
                dbg.cells += result.dbg.cells;
                dbg.grayCells += result.dbg.grayCells;

                if (DEBUG && result.zones.length > 0) {
                    drawDebugOverlay(page, p, result.zones, allEntries).catch(err =>
                        console.warn('Overlay error:', err)
                    );
                }
            }

            const merged = mergeConsecutive(allEntries);
            merged.sort((a, b) =>
                a.date.localeCompare(b.date) || a.start.localeCompare(b.start));

            pdfParsedData = merged;
            showPdfPreview(merged);
            console.log('[HORAX] Debug PDF:', dbg, '→', merged.length, 'extras');

            if (merged.length === 0) {
                const box = document.getElementById('pdfError');
                box.style.display = 'block';
                box.textContent = `No se detectaron extras. Debug: ${dbg.weekGroups} semanas, ${dbg.cols} columnas, ${dbg.rows} filas, ${dbg.cells} celdas, ${dbg.grayCells} grises.`;
                showToast('No se detectaron extras');
            }
        } catch (err) {
            console.error('[HORAX] Error:', err);
            const box = document.getElementById('pdfError');
            box.style.display = 'block';
            box.textContent = 'Error al procesar el PDF: ' + err.message;
            showToast('Error al leer el PDF');
        }
    };
    reader.readAsArrayBuffer(file);
}

// ============================================================
//  PARSER PRINCIPAL (FOTO / IMAGEN) — usa OCR (Tesseract.js) para
//  "leer" el texto y después reutiliza exactamente la misma lógica
//  de columnas/filas/colores que el PDF (extractEntriesFromSource).
// ============================================================
let ocrWorkerPromise = null;
function getOcrWorker() {
    if (!ocrWorkerPromise) {
        ocrWorkerPromise = Tesseract.createWorker(IMAGE_OCR_LANG);
    }
    return ocrWorkerPromise;
}

function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => resolve({ img, url });
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
        img.src = url;
    });
}

// dibuja la foto en un canvas (achicándola si es enorme, para que el OCR no tarde de más)
function drawImageToCanvas(img, maxDim) {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) > maxDim) {
        const ratio = maxDim / Math.max(w, h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
}

// pasa la salida jerárquica de Tesseract (blocks → paragraphs → lines → words)
// a la misma forma plana {str,x,y,width,height} que ya usa el resto del parser
function wordsFromOcrResult(data) {
    const items = [];
    if (data && Array.isArray(data.blocks) && data.blocks.length > 0) {
        for (const block of data.blocks) {
            for (const para of block.paragraphs || []) {
                for (const line of para.lines || []) {
                    for (const word of line.words || []) {
                        const text = String(word.text || '').trim();
                        if (!text || !word.bbox) continue;
                        const { x0, y0, x1, y1 } = word.bbox;
                        items.push({ str: text, x: x0, y: y1, width: x1 - x0, height: y1 - y0 });
                    }
                }
            }
        }
    } else if (data && Array.isArray(data.words)) {
        // compatibilidad con versiones donde las palabras vienen en un array plano
        for (const word of data.words) {
            const text = String(word.text || '').trim();
            if (!text || !word.bbox) continue;
            const { x0, y0, x1, y1 } = word.bbox;
            items.push({ str: text, x: x0, y: y1, width: x1 - x0, height: y1 - y0 });
        }
    }
    return items;
}

// tamaño de letra "típico" en la foto, para poder escalar los números
// mágicos del parser (que están calibrados para el PDF) según cada foto
function medianWordHeight(items) {
    const heights = items.map(it => it.height).filter(h => h > 1).sort((a, b) => a - b);
    if (heights.length === 0) return IMAGE_REFERENCE_TEXT_HEIGHT;
    return heights[Math.floor(heights.length / 2)];
}

// ============================================================
//  ★ NUEVO: SEGUNDA PASADA DE OCR CON CONTRASTE LOCAL (SOLO FOTOS)
//  Las celdas que a esta app le importan más son justo las GRISES (son las
//  que marcan "hora extra"), y en la foto esas celdas tienen letra gris
//  oscuro sobre fondo gris clarito: mucho menos contraste que el resto de
//  la planilla (letra oscura sobre blanco, o sobre un color fuerte). Un
//  umbral "global" — que es más o menos lo que hace Tesseract por dentro
//  antes de leer — separa bien letra/fondo cuando la diferencia de brillo
//  es grande, pero con una celda gris sobre gris puede directamente no
//  detectar el texto. La solución: convertir la foto a blanco y negro con
//  un umbral LOCAL (algoritmo de Bradley, calculado rápido con una "imagen
//  integral"), que compara cada píxel contra el promedio de su propia zona
//  cercana en vez de contra toda la foto — así ese contraste chico alcanza
//  igual. Se corre el OCR sobre ESA versión también, y se combinan ambas
//  lecturas (evitando duplicar lo que ya se había leído bien en la
//  primera pasada), en vez de reemplazar la pasada original — así, si esta
//  segunda pasada lee peor alguna zona, no se pierde lo que ya andaba bien.
// ============================================================
function adaptiveBinarizeForOcr(canvas, windowSize) {
    const w = canvas.width, h = canvas.height;
    const srcCtx = canvas.getContext('2d', { willReadFrequently: true });
    const { data: src } = srcCtx.getImageData(0, 0, w, h);

    const gray = new Float64Array(w * h);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
        gray[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    }

    // imagen integral: permite sacar el promedio de brillo de cualquier
    // ventana rectangular en tiempo constante, sin tener que recorrerla
    // píxel a píxel cada vez (si no, sería demasiado lento en fotos grandes)
    const stride = w + 1;
    const integral = new Float64Array(stride * (h + 1));
    for (let y = 0; y < h; y++) {
        let rowSum = 0;
        const rowOut = (y + 1) * stride;
        const rowPrev = y * stride;
        for (let x = 0; x < w; x++) {
            rowSum += gray[y * w + x];
            integral[rowOut + x + 1] = integral[rowPrev + x + 1] + rowSum;
        }
    }
    const areaSum = (x0, y0, x1, y1) =>
        integral[(y1 + 1) * stride + (x1 + 1)] - integral[y0 * stride + (x1 + 1)]
        - integral[(y1 + 1) * stride + x0] + integral[y0 * stride + x0];

    const S = Math.max(12, Math.min(200, Math.round(windowSize || 60)));
    const half = Math.floor(S / 2);
    const T = 0.88; // qué tan más oscuro que su entorno tiene que ser un píxel para contar como "letra"

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w; outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d');
    const outData = outCtx.createImageData(w, h);

    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
            const count = (x1 - x0 + 1) * (y1 - y0 + 1);
            const mean = areaSum(x0, y0, x1, y1) / count;
            const isText = gray[y * w + x] < mean * T;
            const idx = (y * w + x) * 4;
            const v = isText ? 0 : 255;
            outData.data[idx] = v; outData.data[idx + 1] = v; outData.data[idx + 2] = v; outData.data[idx + 3] = 255;
        }
    }
    outCtx.putImageData(outData, 0, 0);
    return outCanvas;
}

// combina las palabras de una segunda pasada de OCR con las de la primera,
// evitando agregar de nuevo una palabra que ya se había leído (misma zona)
function mergeOcrWordSets(primary, secondary) {
    const out = primary.slice();
    for (const w2 of secondary) {
        const cx2 = w2.x + w2.width / 2, cy2 = w2.y - w2.height / 2;
        let dup = false;
        for (const w1 of primary) {
            const cx1 = w1.x + w1.width / 2, cy1 = w1.y - w1.height / 2;
            const tol = Math.max(w1.height, w2.height, 6);
            if (Math.abs(cx1 - cx2) < tol * 2 && Math.abs(cy1 - cy2) < tol) { dup = true; break; }
        }
        if (!dup) out.push(w2);
    }
    return out;
}

// ============================================================
//  ★ NUEVO: RELECTURA DIRIGIDA DE CELDAS GRISES SIN NOMBRE (SOLO FOTOS)
//  En vez de agrandar TODA la foto (lento, y a veces ni así alcanza para
//  que el OCR general la lea bien), esto aprovecha que extractEntriesFromSource
//  ya barrió la grilla por COLOR y encontró celdas grises (=hora extra) sin
//  nombre asociado: para cada una de esas pocas celdas puntuales, se recorta
//  esa zona de la foto, se agranda fuerte SOLO ese recorte chiquito, se le
//  sube el contraste, y se relee con OCR en modo "una sola línea" (mucho más
//  preciso para un recorte chico con un solo nombre que el modo automático
//  que usa la pasada general sobre toda la foto).
// ============================================================
async function ocrCropForName(worker, sourceCanvas, rect) {
    const pad = Math.max(2, Math.round((rect.bottom - rect.top) * 0.2));
    const x0 = Math.max(0, Math.floor(rect.left - pad));
    const y0 = Math.max(0, Math.floor(rect.top - pad));
    const x1 = Math.min(sourceCanvas.width, Math.ceil(rect.right + pad));
    const y1 = Math.min(sourceCanvas.height, Math.ceil(rect.bottom + pad));
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 4 || ch < 4) return null;

    // agranda el recorte para que la letra quede grande y nítida
    const targetH = 220;
    const scale = Math.min(10, Math.max(2, targetH / ch));
    const outW = Math.round(cw * scale), outH = Math.round(ch * scale);

    const upCanvas = document.createElement('canvas');
    upCanvas.width = outW; upCanvas.height = outH;
    const upCtx = upCanvas.getContext('2d');
    upCtx.imageSmoothingEnabled = true;
    upCtx.imageSmoothingQuality = 'high';
    upCtx.drawImage(sourceCanvas, x0, y0, cw, ch, 0, 0, outW, outH);

    let ocrTarget = upCanvas;
    try {
        ocrTarget = adaptiveBinarizeForOcr(upCanvas, Math.max(15, Math.round(outH / 5)));
    } catch (_) { /* si falla el binarizado, se intenta igual con el recorte agrandado a color */ }

    try {
        const { data } = await worker.recognize(ocrTarget, {}, { text: true });
        return extractPersonName((data && data.text) || '');
    } catch (_) {
        return null;
    }
}

async function retryMissingGrayCells(worker, canvas, missingCells) {
    if (!missingCells || missingCells.length === 0) return [];
    const MAX_RETRIES = 60; // límite de seguridad para no tardar de más si algo salió raro
    const cells = missingCells.slice(0, MAX_RETRIES);
    const recovered = [];
    let psmChanged = false;
    try {
        await worker.setParameters({ tessedit_pageseg_mode: '7' }); // 1 sola línea de texto
        psmChanged = true;
    } catch (_) {}
    for (const cell of cells) {
        const name = await ocrCropForName(worker, canvas, cell);
        if (name) recovered.push({ date: cell.date, start: cell.start, end: cell.end, person: name, done: false });
    }
    if (psmChanged) {
        try { await worker.setParameters({ tessedit_pageseg_mode: '3' }); } catch (_) {} // vuelve al modo automático para la próxima foto
    }
    return recovered;
}

async function parseImageFiles(files) {
    if (!files || files.length === 0) return;
    if (typeof Tesseract === 'undefined') {
        showToast('El lector de fotos (OCR) no cargó. Revisá tu conexión e intentá de nuevo.');
        return;
    }

    const dropZone = document.getElementById('pdfDropZone');
    const dropText = document.getElementById('pdfDropText');
    const defaultDropText = dropText ? dropText.textContent : '';
    const errorBox = document.getElementById('pdfError');
    errorBox.style.display = 'none';
    errorBox.style.color = '#EF4444';
    if (dropZone) dropZone.classList.add('processing');

    const monthState = { lastGlobalDay: 0, globalMonth: hoyMVD().month, globalYear: hoyMVD().year };
    const allEntries = [];
    const dbgTotal = { images: 0, weekGroups: 0, cols: 0, rows: 0, cells: 0, grayCells: 0, syntheticRows: false, calibratedRows: false, recoveredCells: 0, grayCellsRetried: 0 };

    try {
        const worker = await getOcrWorker();

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (dropText) dropText.textContent = files.length > 1
                ? `Leyendo foto ${i + 1} de ${files.length}…`
                : 'Leyendo la foto…';

            const yearInName = String(file.name || '').match(/20\d{2}/);
            if (yearInName) monthState.globalYear = parseInt(yearInName[0], 10);

            const { img, url } = await loadImageFromFile(file);
            const canvas = drawImageToCanvas(img, IMAGE_MAX_DIMENSION);
            URL.revokeObjectURL(url);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
            let items = wordsFromOcrResult(data);

            // ★ NUEVO: segunda pasada sobre una versión con contraste local
            // (ver adaptiveBinarizeForOcr), para no perder las celdas grises
            // con poco contraste letra/fondo. Si algo falla acá (foto rarísima,
            // sin memoria, etc.) seguimos con lo que ya se leyó en la primera
            // pasada — nunca debe tirar abajo toda la importación.
            try {
                const windowSize = medianWordHeight(items) * 6 || 60;
                const enhancedCanvas = adaptiveBinarizeForOcr(canvas, windowSize);
                const { data: data2 } = await worker.recognize(enhancedCanvas, {}, { text: true, blocks: true });
                const items2 = wordsFromOcrResult(data2);
                items = mergeOcrWordSets(items, items2);
            } catch (errEnhance) {
                console.warn('[HORAX] Segunda pasada de OCR (contraste) falló, sigo con la primera:', errEnhance);
            }

            dbgTotal.images++;
            if (items.length === 0) continue;

            const detectedMonthName = detectMonthFromTexts(items);
            const baseMonth = MONTH_MAP[detectedMonthName] ?? monthState.globalMonth;
            const geomScale = medianWordHeight(items) / IMAGE_REFERENCE_TEXT_HEIGHT;

            const result = extractEntriesFromSource(
                items, imageData, /* colorScale */ 1, geomScale, baseMonth, monthState, /* fixedTextHeight */ null,
                /* synthesizeRowsIfMissing */ true, /* colorTolerance */ IMAGE_COLOR_TOLERANCE,
                /* detectMissingGrayCells */ true
            );
            allEntries.push(...result.entries);
            dbgTotal.weekGroups += result.dbg.weekGroups;
            dbgTotal.cols += result.dbg.cols;
            dbgTotal.rows += result.dbg.rows;
            dbgTotal.cells += result.dbg.cells;
            dbgTotal.grayCells += result.dbg.grayCells;
            if (result.dbg.syntheticRows) dbgTotal.syntheticRows = true;
            if (result.dbg.calibratedRows) dbgTotal.calibratedRows = true;

            // ★ NUEVO: celdas grises detectadas por color pero sin nombre leído
            // todavía — releerlas puntualmente con zoom antes de seguir con la
            // próxima foto (ver ocrCropForName / retryMissingGrayCells más arriba).
            if (result.missingGrayCells && result.missingGrayCells.length > 0) {
                try {
                    const recovered = await retryMissingGrayCells(worker, canvas, result.missingGrayCells);
                    if (recovered.length > 0) {
                        allEntries.push(...recovered);
                        dbgTotal.recoveredCells = (dbgTotal.recoveredCells || 0) + recovered.length;
                    }
                    dbgTotal.grayCellsRetried = (dbgTotal.grayCellsRetried || 0) + result.missingGrayCells.length;
                } catch (errRetry) {
                    console.warn('[HORAX] Relectura dirigida de celdas grises falló:', errRetry);
                }
            }
        }

        const merged = mergeConsecutive(allEntries);
        merged.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));

        pdfParsedData = merged;
        showPdfPreview(merged);
        console.log('[HORAX] Debug foto:', dbgTotal, '→', merged.length, 'extras');

        // ★ NUEVO: si hubo celdas grises sin nombre que necesitaron la
        // relectura con zoom, se arma un aviso aparte con cuántas se
        // pudieron recuperar así y cuántas siguen sin leerse ni con zoom
        // (esas sí conviene revisarlas/cargarlas a mano). Se combina con
        // el resto de los avisos de abajo, si hay, para no pisarlos.
        let zoomNote = '';
        if (dbgTotal.grayCellsRetried > 0) {
            const stillMissing = dbgTotal.grayCellsRetried - dbgTotal.recoveredCells;
            zoomNote = stillMissing > 0
                ? `Había ${dbgTotal.grayCellsRetried} celda(s) gris(es) con letra chica/bajo contraste: se pudieron recuperar ${dbgTotal.recoveredCells} haciendo zoom, pero ${stillMissing} siguen sin leerse — convendría revisarlas o cargarlas a mano. `
                : `Había ${dbgTotal.grayCellsRetried} celda(s) gris(es) con letra chica/bajo contraste; se recuperaron las ${dbgTotal.recoveredCells} haciendo zoom sobre esa zona. `;
        }

        if (merged.length === 0) {
            errorBox.style.display = 'block';
            errorBox.textContent = zoomNote + `No se detectaron extras en la foto. Probá con más luz, sin inclinar la cámara, y que el texto se lea nítido. ` +
                `Debug: ${dbgTotal.weekGroups} semanas, ${dbgTotal.cols} columnas, ${dbgTotal.rows} filas, ${dbgTotal.cells} celdas con nombre, ${dbgTotal.grayCells} reconocidas como extra.`;
            showToast('No se detectaron extras');
        } else if (dbgTotal.syntheticRows) {
            // ninguna de las dos cosas funcionó: ni la columna de horarios de la
            // izquierda, ni horas sueltas pegadas a algún nombre para calibrar.
            // Los horarios de abajo son una grilla pareja estimada, no lo que dice la foto.
            errorBox.style.display = 'block';
            errorBox.style.color = '#B45309';
            errorBox.textContent = zoomNote + 'Ojo: esta foto no traía la columna de horarios a la izquierda ni horas sueltas junto a los nombres para calcularlas, así que los horarios que ves abajo son estimados (repartidos parejo de 5:00 a 23:00), no leídos de la foto. Revisalos antes de importar, o mejor sacá de nuevo la foto incluyendo esa columna.';
            showToast(`${merged.length} extras con horarios estimados — revisá antes de importar`);
        } else if (dbgTotal.calibratedRows) {
            // la foto no traía la columna de horarios, pero sí había horas sueltas
            // pegadas a algunos nombres (ej. "14:15", "22:15") y se usaron para
            // calcular el resto de las filas. Es bastante más confiable que el
            // reparto parejo, pero igual vale avisar que no vino la columna original.
            errorBox.style.display = 'block';
            errorBox.style.color = '#2563EB';
            errorBox.textContent = zoomNote + 'Esta foto no traía la columna de horarios a la izquierda, pero se calcularon los horarios a partir de las horas que aparecen pegadas a algunos nombres (ej. 14:15, 22:15). Deberían ser bastante confiables, pero revisalos igual antes de importar.';
            showToast(`${merged.length} extras — horarios calculados a partir de la foto`);
        } else if (zoomNote) {
            errorBox.style.display = 'block';
            errorBox.style.color = '#2563EB';
            errorBox.textContent = zoomNote;
            showToast(`${merged.length} extras importadas`);
        }
    } catch (err) {
        console.error('[HORAX] Error OCR:', err);
        errorBox.style.display = 'block';
        errorBox.textContent = 'Error al leer la imagen: ' + err.message;
        showToast('Error al leer la imagen');
    } finally {
        if (dropZone) dropZone.classList.remove('processing');
        if (dropText) dropText.textContent = defaultDropText;
    }
}

function mergeConsecutive(entries) {
    const groups = new Map();
    for (const e of entries) {
        const key = `${e.date}|${e.person}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }
    const merged = [];
    for (const group of groups.values()) {
        group.sort((a, b) => a.start.localeCompare(b.start));
        let current = null;
        for (const e of group) {
            if (!current) {
                current = { ...e };
            } else if (current.end === e.start) {
                current.end = e.end;
            } else if (current.start <= e.start && e.end <= current.end) {
                // contenido
            } else {
                merged.push(current);
                current = { ...e };
            }
        }
        if (current) merged.push(current);
    }
    return merged;
}

function showPdfPreview(entries) {
    const preview = document.getElementById('pdfPreview');
    preview.style.display = 'block';
    document.getElementById('pdfError').style.display = 'none';

    const total = entries.length;
    const peopleSet = new Set(entries.map(e => e.person));
    const peopleList = Array.from(peopleSet).sort();

    document.getElementById('pdfStats').innerHTML = `
        <span><strong>${total}</strong> extras</span>
        <span><strong>${peopleList.length}</strong> personas</span>
        <span><strong>${new Set(entries.map(e => e.date)).size}</strong> días</span>`;

    document.getElementById('pdfPeopleChips').innerHTML = peopleList
        .map(p => `<span class="person-chip" style="background:${getEmployeeColor(p)};">${p}</span>`)
        .join('');

    const previewList = entries.slice(0, 40);
    document.getElementById('pdfExtrasList').innerHTML =
        previewList.map(e => {
            const c = getEmployeeColor(e.person);
            return `<span class="extra-chip" style="border-left-color:${c};">
                ${formatDateDisplay(e.date)} · ${e.person} · ${e.start}-${e.end}</span>`;
        }).join('') +
        (entries.length > 40 ? `<span class="extra-chip">… y ${entries.length - 40} más</span>` : '');

    document.getElementById('pdfImportBtn').disabled = entries.length === 0;
}

// ---- Deshacer la última importación ----
function getLastImportInfo() {
    const ids = overtimeData.map(e => e.importId).filter(Boolean);
    if (ids.length === 0) return null;
    const id = Math.max(...ids);
    return { id, count: overtimeData.filter(e => e.importId === id).length };
}
function renderUndoImport() {
    const zone = document.getElementById('pdfDropZone');
    if (!zone) return;
    let box = document.getElementById('undoImportBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'undoImportBox';
        box.className = 'undo-import';
        zone.insertAdjacentElement('afterend', box);
    }
    const info = getLastImportInfo();
    if (!info) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const when = new Date(info.id).toLocaleString('es-UY', {
        timeZone: 'America/Montevideo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    box.style.display = 'flex';
    box.innerHTML = `<div><strong>Última importación</strong><small>${info.count} ${info.count === 1 ? 'extra' : 'extras'} · ${when}</small></div>
        <button id="undoImportBtn"><i class="fas fa-rotate-left"></i> Deshacer</button>`;
    document.getElementById('undoImportBtn').addEventListener('click', undoLastImport);
}
function undoLastImport() {
    const info = getLastImportInfo();
    if (!info) return;
    if (!confirm(`¿Deshacer la última importación? Se van a borrar ${info.count} ${info.count === 1 ? 'extra' : 'extras'}.`)) return;
    overtimeData = overtimeData.filter(e => e.importId !== info.id);
    saveData(); renderAll();
    showToast('Importación deshecha');
}

let lastImportAt = 0;
function importPdfData() {
    if (!pdfParsedData || pdfParsedData.length === 0) {
        // si el botón dispara la función 2 veces, la 2da ya no tiene datos: no mostrar error
        if (Date.now() - lastImportAt > 2000) showToast('No hay datos para importar');
        return;
    }
    lastImportAt = Date.now();
    // no duplicar extras que ya están cargadas (PDFs que se pisan entre semanas)
    const keyOf = e => `${e.date}|${e.start}|${e.end}|${e.person}`;
    const existing = new Set(overtimeData.map(keyOf));
    const fresh = pdfParsedData.filter(item => !existing.has(keyOf(item)));
    const skipped = pdfParsedData.length - fresh.length;
    let maxId = overtimeData.reduce((m, e) => Math.max(m, e.id), 0);
    const importId = Date.now(); // marca para poder deshacer esta importación
    const newEntries = fresh.map(item => ({
        id: ++maxId, date: item.date, start: item.start,
        end: item.end, person: item.person, done: false, importId
    }));
    overtimeData = overtimeData.concat(newEntries);
    saveData();
    renderAll();
    showToast(`Importadas ${newEntries.length} extras` + (skipped ? ` (${skipped} ya estaban)` : '') + (newEntries.length ? ' · podés deshacer en Importar' : ''), newEntries.length ? 4500 : 2400);
    document.getElementById('pdfPreview').style.display = 'none';
    pdfParsedData = null;

    if (newEntries.length > 0) {
        const [y, m] = newEntries[0].date.split('-').map(Number);
        currentYear = y; currentMonth = m - 1;
        selectedDate = newEntries[0].date;
    }
    switchTab('tabCalendar');
}

function init() {
    const today = hoyDate();
    currentMonth = today.getMonth();
    currentYear = today.getFullYear();
    selectedDate = formatDate(today);
    const addDate = document.getElementById('addDate');
    if (addDate) addDate.value = formatDate(today);

    const googleBtn = document.getElementById('googleLoginBtn');
    if (googleBtn) googleBtn.addEventListener('click', () => {
        const errorEl = document.getElementById('loginError');
        if (errorEl) errorEl.style.display = 'none';
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider).catch(err => {
            console.error('[HORAX] Error de login:', err);
            if (errorEl) {
                errorEl.textContent = err.code === 'auth/unauthorized-domain'
                    ? 'Este sitio todavía no está autorizado en Firebase para iniciar sesión.'
                    : 'No se pudo iniciar sesión: ' + err.message;
                errorEl.style.display = 'block';
            }
        });
    });
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => {
        if (confirm('¿Querés cerrar sesión?')) auth.signOut();
    });

    const profileChip = document.getElementById('profileChip');
    if (profileChip) {
        profileChip.addEventListener('click', () => {
            if (currentUser) openProfileModal(false);
        });
        profileChip.addEventListener('keydown', ev => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                if (currentUser) openProfileModal(false);
            }
        });
    }
    document.getElementById('profileSaveBtn').addEventListener('click', saveProfileFromModal);
    document.getElementById('profileCancelBtn').addEventListener('click', () => closeProfileModal(true));
    document.getElementById('profileModal').addEventListener('click', ev => {
        if (ev.target.id === 'profileModal') closeProfileModal(false);
    });
    ['profileFirstName', 'profileLastName'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', ev => {
            if (ev.key === 'Enter') { ev.preventDefault(); saveProfileFromModal(); }
        });
    });

    document.getElementById('editSaveBtn').addEventListener('click', saveEditFromModal);
    document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
    document.getElementById('editModal').addEventListener('click', ev => {
        if (ev.target.id === 'editModal') closeEditModal();
    });

    document.getElementById('prevMonth').addEventListener('click', () => {
        currentMonth--; if (currentMonth < 0) { currentMonth = 11; currentYear--; }
        selectedDate = null; renderCalendar(); renderSummary();
    });
    document.getElementById('nextMonth').addEventListener('click', () => {
        currentMonth++; if (currentMonth > 11) { currentMonth = 0; currentYear++; }
        selectedDate = null; renderCalendar(); renderSummary();
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            if (tab) switchTab(tab);
        });
    });
    document.getElementById('addSubmitBtn').addEventListener('click', () => {
        const date = document.getElementById('addDate').value;
        const start = document.getElementById('addStart').value;
        const end = document.getElementById('addEnd').value;
        const person = document.getElementById('addPerson').value.trim();
        if (!date || !start || !end || !person) { showToast('Completá todos los campos'); return; }
        if (start >= end) { showToast('El inicio debe ser anterior al final'); return; }
        addEntry(date, start, end, person);
        document.getElementById('addPerson').value = '';
        selectedDate = date;
        switchTab('tabCalendar');
    });
    document.getElementById('clearBtn').addEventListener('click', clearAllData);

    const dropZone = document.getElementById('pdfDropZone');
    const fileInput = document.getElementById('pdfFileInput');

    // Reparte los archivos elegidos: si hay fotos, se procesan todas juntas
    // con OCR; si no hay ninguna foto pero sí un PDF, se usa el lector de PDF.
    function handleImportFiles(fileList) {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;
        const isPdf = f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
        const isImage = f => f.type.startsWith('image/');
        const images = files.filter(isImage);
        if (images.length > 0) {
            parseImageFiles(images);
            return;
        }
        const pdf = files.find(isPdf);
        if (pdf) { parsePdfFile(pdf); return; }
        showToast('Solo se permiten archivos PDF o fotos (imágenes)');
    }

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault(); dropZone.classList.remove('dragover');
        handleImportFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', e => {
        handleImportFiles(e.target.files);
        fileInput.value = '';
    });
    document.getElementById('pdfImportBtn').addEventListener('click', importPdfData);

    // atajos del ícono de la app (manifest.json): #add y #calendar
    const hashTab = { '#add': 'tabAdd', '#calendar': 'tabCalendar' }[location.hash];
    if (hashTab) switchTab(hashTab);

    console.log('✅ HORAX iniciada');
}

document.addEventListener('DOMContentLoaded', init);