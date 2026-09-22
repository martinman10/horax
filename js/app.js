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
    const name = profileDisplayName();
    const title = document.getElementById('headerTitle');
    const sub = document.getElementById('headerSubtitle');
    const chip = document.getElementById('profileChip');

    if (title) title.textContent = name || 'HORAX';
    if (sub) sub.style.display = name ? 'block' : 'none';
    if (chip) chip.title = name ? 'Cambiar mi nombre' : 'HORAX';
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

    document.getElementById('profileModalTitle').innerHTML =
        `<i class="fas fa-id-badge" style="color:var(--primary);margin-right:8px;"></i>` +
        (firstTime ? '¿Cómo te llamás?' : 'Cambiar mi nombre');
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
    userProfile = { firstName, lastName };
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

let overtimeData = [];
let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();
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
    if (!confirm('¿Borrar TODOS los datos guardados?')) return;
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
    const todayStr = formatDate(new Date());
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

function renderSummary() {
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
            const p = byPerson.get(e.person) || { person: e.person, total: 0, done: 0 };
            const h = entryHours(e);
            p.total += h;
            if (e.done) p.done += h;
            byPerson.set(e.person, p);
        }
        const summary = Array.from(byPerson.values())
            .sort((a, b) => b.total - a.total || a.person.localeCompare(b.person, 'es'));

        let sumTotal = 0, sumDone = 0;
        html += `<div class="summary-table"><table><thead><tr>
            <th>Persona</th><th>Horas</th><th>Hechas</th><th>Pendientes</th>
        </tr></thead><tbody>`;
        for (const row of summary) {
            sumTotal += row.total; sumDone += row.done;
            const color = getEmployeeColor(row.person);
            html += `<tr>
                <td class="person-name" style="color:${color};">${row.person}</td>
                <td>${fmtHours(row.total)}</td>
                <td><span class="badge badge-done">${fmtHours(row.done)}</span></td>
                <td><span class="badge badge-pending">${fmtHours(row.total - row.done)}</span></td>
            </tr>`;
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
}

let toastTimeout = null;
function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.remove('show'), 2400);
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
function mergeTextFragments(items) {
    // Paso 1: fusión horizontal, SOLO fragmentos casi pegados
    const linesMap = new Map();
    for (const it of items) {
        const yKey = Math.round(it.y / 4);
        if (!linesMap.has(yKey)) linesMap.set(yKey, []);
        linesMap.get(yKey).push(it);
    }
    let merged = [];
    for (const group of linesMap.values()) {
        group.sort((a, b) => a.x - b.x);
        let current = null;
        for (const it of group) {
            if (current && (it.x - (current.x + current.width)) <= 1) {
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
    for (let i = 0; i < merged.length; i++) {
        if (used[i]) continue;
        let cur = merged[i];
        for (let j = i + 1; j < merged.length; j++) {
            if (used[j]) continue;
            const cand = merged[j];
            const dy = cand.y - cur.y;
            if (dy < 1.5) continue;   // misma línea, ignorar
            if (dy > 5) break;        // ya muy lejos verticalmente, cortar
            const dx = Math.abs(cand.x - cur.x);
            if (dx <= 3) {            // misma columna aprox. = 2da línea del mismo nombre
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

function detectMonthFromTexts(textItems) {
    for (const it of textItems) {
        const s = String(it.str || '').toLowerCase();
        for (const name of Object.keys(MONTH_MAP)) {
            if (s.includes(name)) return name;
        }
    }
    return 'septiembre';
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
function sampleTextBackground(imageData, xTopLeft, yTopLeft, w, h) {
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
            if (lum < 100) continue;
            if (r > 248 && g > 248 && b > 248) continue;
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

    // ★ ÚNICO CAMBIO respecto a v17:
    //   antes: isGray = sat < 30 && lum >= 80 && lum <= 245
    //   ahora: isGray = sat < 30 && lum >= 170 && lum <= 228
    //   → los reales (177-220) pasan; las rayas (236) quedan afuera
    const isWhite = sat < 12 && lum > 228;
    const isGray = sat <= 8 && lum >= 170 && lum <= 225; // gris NEUTRO (sat≈0); excluye violetas/colores pálidos
    const isColor = sat >= 30;

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
function extractEntriesFromSource(rawItems, imageData, colorScale, geomScale, baseMonth, monthState, fixedTextHeight, synthesizeRowsIfMissing) {
    const dbg = { weekGroups: 0, cols: 0, rows: 0, cells: 0, grayCells: 0, syntheticRows: false };
    const entries = [];
    const zones = []; // solo se usa si DEBUG === true, para dibujar el overlay

    const words = mergeTextFragments(rawItems);
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

        // ★ RESPALDO: la foto no trae la columna de horarios de la izquierda
        // (pasa cuando alguien recorta la foto justo al lado de los días, sin
        // dejar el "5:00 - 6:00 / 6:00 - 7:00 / ..." visible). Sin esos textos
        // no hay forma de saber a qué hora corresponde cada fila... salvo que
        // esta planilla SIEMPRE va de 5:00 a 23:00, en filas parejas de 1 hora
        // (18 filas en total). Si no se detectó ninguna hora real, se arma esa
        // grilla estándar repartiendo parejo el alto de la columna. No es tan
        // preciso como leer la hora real, pero es mucho mejor que no leer nada.
        if (uniqueRows.length === 0 && synthesizeRowsIfMissing) {
            const SYNTH_START_HOUR = 5, SYNTH_END_HOUR = 23;
            const totalRows = SYNTH_END_HOUR - SYNTH_START_HOUR;
            const rowH = (weekBottomY - weekContentTop) / totalRows;
            if (rowH > 0) {
                for (let i = 0; i < totalRows; i++) {
                    const h = SYNTH_START_HOUR + i;
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

            const colorInfo = sampleTextBackground(imageData, bboxX, bboxY, bboxW, bboxH);
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
            entries.push({ date: dateStr, start: row.start, end: row.end, person: name, done: false });
        }
    }

    return { entries, dbg, zones };
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
            let globalMonth = 8;
            // el año sale del nombre del archivo (ej. HORARIOS_2026_-_SEPTIEMBRE...); si no lo trae, el año actual
            const yearInName = String((file && file.name) || '').match(/20\d{2}/);
            let globalYear = yearInName ? parseInt(yearInName[0], 10) : new Date().getFullYear();

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
                const baseMonth = MONTH_MAP[detectedMonthName] ?? 8;

                const monthState = { lastGlobalDay, globalMonth, globalYear };
                const result = extractEntriesFromSource(
                    items, rendered.imageData, SCALE, /* geomScale */ 1, baseMonth, monthState, /* fixedTextHeight */ 4,
                    /* synthesizeRowsIfMissing */ false
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

    const monthState = { lastGlobalDay: 0, globalMonth: 8, globalYear: new Date().getFullYear() };
    const allEntries = [];
    const dbgTotal = { images: 0, weekGroups: 0, cols: 0, rows: 0, cells: 0, grayCells: 0, syntheticRows: false };

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
            const items = wordsFromOcrResult(data);
            dbgTotal.images++;
            if (items.length === 0) continue;

            const detectedMonthName = detectMonthFromTexts(items);
            const baseMonth = MONTH_MAP[detectedMonthName] ?? monthState.globalMonth;
            const geomScale = medianWordHeight(items) / IMAGE_REFERENCE_TEXT_HEIGHT;

            const result = extractEntriesFromSource(
                items, imageData, /* colorScale */ 1, geomScale, baseMonth, monthState, /* fixedTextHeight */ null,
                /* synthesizeRowsIfMissing */ true
            );
            allEntries.push(...result.entries);
            dbgTotal.weekGroups += result.dbg.weekGroups;
            dbgTotal.cols += result.dbg.cols;
            dbgTotal.rows += result.dbg.rows;
            dbgTotal.cells += result.dbg.cells;
            dbgTotal.grayCells += result.dbg.grayCells;
            if (result.dbg.syntheticRows) dbgTotal.syntheticRows = true;
        }

        const merged = mergeConsecutive(allEntries);
        merged.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));

        pdfParsedData = merged;
        showPdfPreview(merged);
        console.log('[HORAX] Debug foto:', dbgTotal, '→', merged.length, 'extras');

        if (merged.length === 0) {
            errorBox.style.display = 'block';
            errorBox.textContent = 'No se detectaron extras en la foto. Probá con más luz, sin inclinar la cámara, y que el texto se lea nítido.';
            showToast('No se detectaron extras');
        } else if (dbgTotal.syntheticRows) {
            // la foto no traía la columna de horarios (5:00, 6:00...) visible, así que
            // los horarios de abajo son una grilla pareja estimada, no lo que dice la foto
            errorBox.style.display = 'block';
            errorBox.style.color = '#B45309';
            errorBox.textContent = 'Ojo: esta foto no traía la columna de horarios a la izquierda, así que los horarios que ves abajo son estimados (repartidos parejo de 5:00 a 23:00), no leídos de la foto. Revisalos antes de importar, o mejor sacá de nuevo la foto incluyendo esa columna.';
            showToast(`${merged.length} extras con horarios estimados — revisá antes de importar`);
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
    const newEntries = fresh.map(item => ({
        id: ++maxId, date: item.date, start: item.start,
        end: item.end, person: item.person, done: false
    }));
    overtimeData = overtimeData.concat(newEntries);
    saveData();
    renderAll();
    showToast(`Importadas ${newEntries.length} extras` + (skipped ? ` (${skipped} ya estaban)` : ''));
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
    const today = new Date();
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
    if (logoutBtn) logoutBtn.addEventListener('click', () => auth.signOut());

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
    document.getElementById('resetBtn').addEventListener('click', () => {
        if (confirm('¿Borrar todos los datos actuales?')) {
            overtimeData = [];
            employeeColorsCache.clear();
            saveData(); renderAll(); showToast('Datos borrados');
        }
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