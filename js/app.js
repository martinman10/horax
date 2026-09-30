// ============================================================
//  CONFIGURACIÓN
// ============================================================
const STORAGE_KEY = 'xtraspilar_v22'; // no cambiar: es la clave donde ya hay datos guardados en este dispositivo
const DEBUG = false; // ← poné true solo si querés ver el overlay de depuración

// Esta cuenta siempre entra como admin (ve todos los locales). Cualquier otra
// cuenta que inicie sesión por primera vez se da de alta sola como "encargada".
const ADMIN_EMAIL = 'martinmaneiro6@gmail.com';

// Guardamos cómo es la tarjeta de login apenas arranca la página (con el botón
// "Continuar con Google"), para poder devolverla a ese estado al cerrar sesión,
// aunque haya quedado con el formulario de alta automática o el aviso de "sin local".
const LOGIN_CARD_DEFAULT_HTML = (() => {
    const el = document.querySelector('#loginScreen .login-card');
    return el ? el.innerHTML : '';
})();

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
function localDocRef(id) { return db.collection('locals').doc(id); }
// Historial de auditoría: subcolección aparte del documento del local (ver
// comentario junto a logAudit() más abajo sobre por qué no es un array).
function auditLogRef(id) { return localDocRef(id).collection('auditLog'); }
function localsCollectionRef() { return db.collection('locals'); }

// ---- Multi-local ----
// currentRole: 'admin' (ve todos los locales) | 'encargada' (ve solo el suyo)
let currentRole = null;
let currentLocalId = null;      // local que se está mostrando ahora
let availableLocals = [];       // [{id, name}] — solo se llena para admin
let localDocUnsubscribe = null;
function lastLocalKey(uid) { return 'horax_last_local_' + uid; }

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
    let data = null;
    try {
        const snap = await ref.get();
        if (snap.exists) data = snap.data() || {};
    } catch (err) {
        console.error('[HORAX] Error cargando el usuario:', err);
        showLoading(false);
        showNoLocalScreen(user.email, true);
        return;
    }

    if (!data || !data.role) {
        // Primera vez que esta cuenta inicia sesión: se da de alta sola.
        showLoading(false);
        showOnboardingScreen(user);
        return;
    }

    if (data.profile && data.profile.firstName) userProfile = data.profile;
    currentRole = data.role;

    if (currentRole === 'admin') {
        try {
            const snap = await localsCollectionRef().get();
            availableLocals = snap.docs
                .map(d => ({ id: d.id, name: (d.data() && d.data().name) || d.id }))
                .sort((a, b) => a.name.localeCompare(b.name, 'es'));
        } catch (err) {
            console.error('[HORAX] Error cargando la lista de locales:', err);
            availableLocals = [];
        }
        if (availableLocals.length === 0) {
            showLoading(false);
            showNoLocalScreen(user.email, false, 'Todavía no hay ningún local creado.');
            return;
        }
        let lastId = null;
        try { lastId = localStorage.getItem(lastLocalKey(user.uid)); } catch (_) {}
        currentLocalId = availableLocals.some(l => l.id === lastId) ? lastId : availableLocals[0].id;
    } else {
        currentLocalId = data.localId || null;
        if (!currentLocalId) {
            showLoading(false);
            showNoLocalScreen(user.email, false);
            return;
        }
    }

    applyProfileToHeader();
    renderLocalBar();
    updateAdminTabVisibility();
    subscribeToLocal(currentLocalId);
    showLoading(false);
    syncPushToken(); // ★ NUEVO: si ya activó los avisos en este dispositivo, mantiene el token al día

    // Si todavía no eligió cómo llamarse, se lo pedimos antes de empezar.
    if (!userProfile || !userProfile.firstName) openProfileModal(true);
        // Banner "Instalá la app" (aparece la primera vez, si no está instalada)
    maybeShowInstallBanner();

    if (userDocUnsubscribe) userDocUnsubscribe();
    userDocUnsubscribe = ref.onSnapshot(doc => {
        if (!doc.exists) return;
        const d = doc.data() || {};
        if (d.profile && JSON.stringify(d.profile) !== JSON.stringify(userProfile)) {
            userProfile = d.profile;
            saveLocalProfile();
            applyProfileToHeader();
        }
    }, err => console.error('[HORAX] Error escuchando cambios de perfil:', err));
}

// Cuenta logueada pero sin ningún local asignado todavía (falta que la cargues en Firebase)
function showNoLocalScreen(email, isConnError, customMsg) {
    const card = document.querySelector('#loginScreen .login-card');
    if (!card) return;
    const msg = customMsg ||
        (isConnError
            ? 'No se pudo conectar para revisar tu acceso. Probá de nuevo en un momento.'
            : `Tu cuenta (${escapeHtml(email || '')}) todavía no fue asignada a ningún local. Pedile a quien administra HORAX que te habilite el acceso.`);
    card.innerHTML = `
        <div class="logo"><i class="fas fa-store-slash"></i></div>
        <h1>HORAX</h1>
        <p>${msg}</p>
        <button id="noLocalLogoutBtn" class="btn-google"><i class="fas fa-sign-out-alt"></i> Cerrar sesión</button>`;
    document.getElementById('noLocalLogoutBtn').addEventListener('click', () => auth.signOut());
    showLoginScreen(true);
}

// Cuenta que inicia sesión con Google por primera vez: le pedimos nombre
// (y local, si no es la admin) y creamos su usuario en Firebase solos,
// sin que nadie tenga que cargarla a mano.
async function showOnboardingScreen(user) {
    const card = document.querySelector('#loginScreen .login-card');
    if (!card) return;
    const isAdmin = (user.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();

    let locals = [];
    if (!isAdmin) {
        try {
            const snap = await localsCollectionRef().get();
            locals = snap.docs
                .map(d => ({ id: d.id, name: (d.data() && d.data().name) || d.id }))
                .sort((a, b) => a.name.localeCompare(b.name, 'es'));
        } catch (err) {
            console.error('[HORAX] Error cargando los locales:', err);
            card.innerHTML = `
                <div class="logo"><i class="fas fa-triangle-exclamation"></i></div>
                <h1>HORAX</h1>
                <p>No se pudo conectar para traer la lista de locales. Probá de nuevo en un momento.</p>
                <button id="onbRetryBtn" class="btn-google"><i class="fas fa-rotate-right"></i> Reintentar</button>
                <button id="onbLogoutBtn" class="btn-secondary" style="margin-top:10px;">Cerrar sesión</button>`;
            document.getElementById('onbRetryBtn').addEventListener('click', () => showOnboardingScreen(user));
            document.getElementById('onbLogoutBtn').addEventListener('click', () => auth.signOut());
            showLoginScreen(true);
            return;
        }
        if (locals.length === 0) {
            card.innerHTML = `
                <div class="logo"><i class="fas fa-store-slash"></i></div>
                <h1>HORAX</h1>
                <p>Todavía no hay ningún local creado. Pedile a quien administra HORAX que cree uno primero.</p>
                <button id="onbLogoutBtn" class="btn-google"><i class="fas fa-sign-out-alt"></i> Cerrar sesión</button>`;
            document.getElementById('onbLogoutBtn').addEventListener('click', () => auth.signOut());
            showLoginScreen(true);
            return;
        }
    }

    // Proponemos el nombre de la cuenta de Google, editable.
    const parts = (user.displayName || '').trim().split(/\s+/).filter(Boolean);
    const guessFirst = escapeHtml(parts.shift() || '');
    const guessLast = parts.join(' ');
    const localOptions = locals.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('');

    card.innerHTML = `
        <div class="logo"><i class="fas fa-user-check"></i></div>
        <h1>HORAX</h1>
        <p>${isAdmin
            ? 'Bienvenido. Completá tu nombre para empezar.'
            : 'Es tu primera vez acá. Contanos tu nombre y en qué local trabajás.'}</p>
        <div class="form-group">
            <label>Nombre</label>
            <input type="text" id="onbFirstName" placeholder="Ej: Karla" value="${guessFirst}" />
        </div>
        <div class="form-group">
            <label>Apellido <span class="label-opt">(opcional)</span></label>
            <input type="text" id="onbLastName" placeholder="Ej: Pérez" value="${escapeHtml(guessLast)}" />
        </div>
        ${isAdmin ? '' : `
        <div class="form-group">
            <label>Local</label>
            <select id="onbLocal">${localOptions}</select>
        </div>`}
        <p id="onbError" class="login-error" style="display:none;"></p>
        <button id="onbSaveBtn" class="btn-submit"><i class="fas fa-check"></i> Empezar</button>
        <button id="onbLogoutBtn" class="btn-secondary">Cerrar sesión</button>`;

    document.getElementById('onbLogoutBtn').addEventListener('click', () => auth.signOut());
    const saveBtn = document.getElementById('onbSaveBtn');
    saveBtn.addEventListener('click', async () => {
        const firstName = document.getElementById('onbFirstName').value.trim();
        const lastName = document.getElementById('onbLastName').value.trim();
        const errorEl = document.getElementById('onbError');
        errorEl.style.display = 'none';
        if (!firstName) {
            errorEl.textContent = 'Escribí al menos tu nombre para continuar.';
            errorEl.style.display = 'block';
            return;
        }
        let localId = null;
        if (!isAdmin) {
            localId = document.getElementById('onbLocal').value;
            if (!localId) {
                errorEl.textContent = 'Elegí tu local para continuar.';
                errorEl.style.display = 'block';
                return;
            }
        }
        const payload = {
            email: user.email || null,
            role: isAdmin ? 'admin' : 'encargada',
            profile: { firstName, lastName, themeColor: THEME_DEFAULT }
        };
        if (!isAdmin) payload.localId = localId;

        saveBtn.disabled = true;
        showLoading(true);
        try {
            await userDocRef(user.uid).set(payload, { merge: true });
            showLoading(false);
            handleSignedIn(user); // recarga todo, ahora la cuenta ya tiene rol y local
        } catch (err) {
            console.error('[HORAX] Error dando de alta al usuario:', err);
            showLoading(false);
            saveBtn.disabled = false;
            errorEl.textContent = 'No se pudo guardar, probá de nuevo.';
            errorEl.style.display = 'block';
        }
    });

    showLoginScreen(true);
}

// Se suscribe a los datos de un local puntual (reemplaza la suscripción anterior si había una)
function subscribeToLocal(localId) {
    if (localDocUnsubscribe) { localDocUnsubscribe(); localDocUnsubscribe = null; }
    currentLocalId = localId;
    if (currentUser) {
        try { localStorage.setItem(lastLocalKey(currentUser.uid), localId); } catch (_) {}
    }
    localDocUnsubscribe = localDocRef(localId).onSnapshot(doc => {
        if (suppressNextSnapshot) { suppressNextSnapshot = false; return; }
        const remote = (doc.exists && doc.data().entries) || [];
        overtimeData = remote;
        employeeColorsCache.clear();
        renderAll();
    }, err => {
        console.error('[HORAX] Error escuchando el local:', err);
        showToast('No se pudo conectar a la nube, revisá tu conexión');
    });
}

// El admin elige otro local desde el desplegable
function switchLocal(localId) {
    if (!localId || localId === currentLocalId) return;
    selectedDate = null;
    subscribeToLocal(localId);
    renderLocalBar();
}

// Barra con el selector de local: solo se ve si el rol es admin
function renderLocalBar() {
    let bar = document.getElementById('localBar');
    if (currentRole !== 'admin') {
        if (bar) bar.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'localBar';
        bar.className = 'local-bar';
        const header = document.querySelector('.app-header');
        if (header) header.insertAdjacentElement('afterend', bar);
    }
    const options = availableLocals
        .map(l => `<option value="${escapeHtml(l.id)}" ${l.id === currentLocalId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`)
        .join('');
    bar.innerHTML = `<i class="fas fa-store"></i>
        <select id="localSelector" aria-label="Elegir local">${options}</select>`;
    document.getElementById('localSelector').addEventListener('change', e => switchLocal(e.target.value));
}

// ============================================================
//  PANEL DE ADMINISTRACIÓN
//  Solo lo ve currentRole === 'admin'. Permite ver/editar el rol y local de
//  cada cuenta y borrar cuentas (encargadas u otras admins), sin entrar a
//  la consola de Firebase. También permite crear, renombrar y borrar locales.
//  Editar/borrar OTRA cuenta, listar la colección users y crear/editar/borrar
//  locales requieren reglas de Firestore que autoricen al admin (ver el
//  mensaje aparte con las reglas).
//  Nota: borrar una cuenta acá solo borra su documento en Firestore (pierde
//  rol y local al toque). No borra el login de Firebase Auth: si esa persona
//  vuelve a entrar con esa cuenta, la app la trata como "primera vez" y le
//  vuelve a pedir nombre y local (se auto-asigna admin de nuevo si el mail
//  es el ADMIN_EMAIL fijo). Para dar de baja el login en sí hay que ir a la
//  consola de Firebase (Authentication).
// ============================================================
let adminUsers = [];          // cache de {uid, email, role, localId, profile} para el panel
let adminUsersLoaded = false;
const ROLE_LABEL = { admin: 'Admin', encargada: 'Encargada' };

function updateAdminTabVisibility() {
    const btn = document.getElementById('adminTabBtn');
    if (!btn) return;
    const show = currentRole === 'admin';
    btn.style.display = show ? 'flex' : 'none';
    if (!show && currentTab === 'tabAdmin') switchTab('tabCalendar');
}

function localNameById(id) {
    const found = availableLocals.find(l => l.id === id);
    return found ? found.name : (id || '—');
}

// tabAdmin se muestra: se llama cada vez que se entra a ese tab.
function renderAdminPanel() {
    if (currentRole !== 'admin') return;
    if (adminUsersLoaded) { renderAdminUsersList(); renderAdminLocalsList(); }
    loadAdminUsers(); // igual refresca en segundo plano por si algo cambió
}

async function loadAdminUsers() {
    const list = document.getElementById('adminUsersList');
    if (!adminUsersLoaded && list) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-circle-notch fa-spin"></i><p>Cargando usuarios...</p></div>`;
    }
    try {
        const snap = await db.collection('users').get();
        adminUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        adminUsersLoaded = true;
    } catch (err) {
        console.error('[HORAX] Error cargando usuarios:', err);
        if (list && !adminUsers.length) {
            list.innerHTML = `<div class="empty-state"><i class="fas fa-triangle-exclamation"></i><p>No se pudo cargar la lista de usuarios</p></div>`;
        }
        return;
    }
    renderAdminUsersList();
    renderAdminLocalsList();
}

function renderAdminUsersList() {
    const list = document.getElementById('adminUsersList');
    if (!list) return;
    if (adminUsers.length === 0) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-user-slash"></i><p>No hay usuarios cargados todavía</p></div>`;
        return;
    }
    const sorted = [...adminUsers].sort((a, b) => (a.email || '').localeCompare(b.email || '', 'es'));
    list.innerHTML = sorted.map(u => {
        const name = (u.profile && [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ').trim()) || '(sin nombre)';
        const isSelf = currentUser && u.uid === currentUser.uid;
        return `<div class="admin-user-card">
            <div class="admin-user-info">
                <p class="admin-user-name">${escapeHtml(name)}${isSelf ? ' <span class="admin-you-tag">(vos)</span>' : ''}</p>
                <p class="admin-user-email">${escapeHtml(u.email || '—')}</p>
                <div class="admin-user-badges">
                    <span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-encargada'}">${ROLE_LABEL[u.role] || u.role || '—'}</span>
                    ${u.role === 'encargada' ? `<span class="badge badge-local">${escapeHtml(localNameById(u.localId))}</span>` : ''}
                </div>
            </div>
            ${isSelf ? '' : `<div class="admin-user-actions">
                <button class="sd-btn sd-edit admin-edit-btn" data-uid="${u.uid}" title="Editar acceso"><i class="fas fa-pen"></i></button>
                <button class="sd-btn sd-delete admin-delete-user-btn" data-uid="${u.uid}" title="Eliminar cuenta"><i class="fas fa-trash-alt"></i></button>
            </div>`}
        </div>`;
    }).join('');
    list.querySelectorAll('.admin-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => openEditUserModal(btn.dataset.uid));
    });
    list.querySelectorAll('.admin-delete-user-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteUserFromAdmin(btn.dataset.uid));
    });
}

// Borra el documento de la cuenta en Firestore (pierde rol y local).
// No borra el login de Firebase Auth (ver nota más arriba).
async function deleteUserFromAdmin(uid) {
    const u = adminUsers.find(x => x.uid === uid);
    if (!u) return;
    if (currentUser && uid === currentUser.uid) return; // por las dudas, nunca a sí misma
    const name = (u.profile && [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ').trim()) || u.email || 'esta cuenta';
    const isHardcodedAdmin = (u.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();
    let message = `Se va a eliminar el acceso de ${name} (${u.email || 'sin mail'}). Esta acción no se puede deshacer. Si vuelve a iniciar sesión con esa cuenta, la app la va a tratar como nueva y le va a volver a pedir nombre y local.`;
    if (isHardcodedAdmin) {
        message += ' Ojo: ese mail está configurado como admin fijo de la app, así que va a recuperar el rol de admin apenas vuelva a entrar.';
    }
    const ok = await showConfirm({
        title: '¿Eliminar esta cuenta?',
        message,
        okText: 'Eliminar',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    try {
        await userDocRef(uid).delete();
        adminUsers = adminUsers.filter(x => x.uid !== uid);
        renderAdminUsersList();
        showToast(`Cuenta de ${name} eliminada`);
    } catch (err) {
        console.error('[HORAX] Error eliminando la cuenta:', err);
        showToast('No se pudo eliminar la cuenta');
    }
}

// Local que se está renombrando ahora (null = ninguno)
let editingLocalId = null;

function renderAdminLocalsList() {
    const list = document.getElementById('adminLocalsList');
    if (!list) return;
    if (availableLocals.length === 0) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-store-slash"></i><p>No hay locales creados</p></div>`;
        return;
    }
    // Si justo se refresca la lista mientras escribís un nombre, no se pierde lo escrito
    const prevInput = document.getElementById('localRenameInput');
    const draft = prevInput ? prevInput.value : null;

    const sorted = [...availableLocals].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    list.innerHTML = sorted.map(l => {
        if (l.id === editingLocalId) {
            return `
        <div class="admin-local-row editing">
            <input type="text" class="local-rename-input" id="localRenameInput" maxlength="40"
                   value="${escapeHtml(draft !== null ? draft : l.name)}" aria-label="Nuevo nombre del local" autocomplete="off" />
            <div class="admin-local-actions">
                <button class="sd-btn sd-ok local-rename-ok" data-id="${escapeHtml(l.id)}" title="Guardar"><i class="fas fa-check"></i></button>
                <button class="sd-btn sd-cancel local-rename-cancel" title="Cancelar"><i class="fas fa-xmark"></i></button>
            </div>
        </div>`;
        }
        return `
        <div class="admin-local-row">
            <span class="admin-local-name"><i class="fas fa-store"></i> <span class="admin-local-text">${escapeHtml(l.name)}</span></span>
            <div class="admin-local-actions">
                <button class="sd-btn sd-edit local-edit-btn" data-id="${escapeHtml(l.id)}" title="Renombrar"><i class="fas fa-pen"></i></button>
                <button class="sd-btn sd-delete local-delete-btn" data-id="${escapeHtml(l.id)}" title="Borrar local"><i class="fas fa-trash-alt"></i></button>
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.local-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            editingLocalId = btn.dataset.id;
            renderAdminLocalsList();
        });
    });
    list.querySelectorAll('.local-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteLocal(btn.dataset.id));
    });
    const okBtn = list.querySelector('.local-rename-ok');
    const cancelBtn = list.querySelector('.local-rename-cancel');
    const input = document.getElementById('localRenameInput');
    if (okBtn && input) {
        const confirmRename = () => renameLocal(okBtn.dataset.id, input.value);
        const cancelRename = () => { editingLocalId = null; renderAdminLocalsList(); };
        okBtn.addEventListener('click', confirmRename);
        cancelBtn.addEventListener('click', cancelRename);
        input.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') { ev.preventDefault(); confirmRename(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(); }
        });
        if (draft === null) { input.focus(); input.select(); }
    }
}

// ---- Crear / renombrar / borrar locales (solo admin) ----
// Vuelve a leer la lista de locales de Firestore y refresca la barra, el
// selector de local, la lista del panel y las etiquetas de local de las cuentas.
async function reloadAvailableLocals() {
    const snap = await localsCollectionRef().get();
    availableLocals = snap.docs
        .map(d => ({ id: d.id, name: (d.data() && d.data().name) || d.id }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    renderLocalBar();
    renderAdminLocalsList();
    if (adminUsersLoaded) renderAdminUsersList();
}

function cleanLocalName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ');
}
function isDuplicateLocalName(name, exceptId) {
    const n = normalizeText(name);
    return availableLocals.some(l => l.id !== exceptId && normalizeText(l.name.trim()) === n);
}
function localErrorMessage(err, fallback) {
    if (err && err.code === 'permission-denied') {
        return 'Firebase no dejó hacer el cambio: faltan permisos de admin en las reglas de Firestore.';
    }
    return fallback;
}

async function createLocal(name) {
    const clean = cleanLocalName(name);
    if (!clean) return { ok: false, error: 'Escribí un nombre para el local.' };
    if (clean.length > 40) return { ok: false, error: 'El nombre puede tener hasta 40 letras.' };
    if (isDuplicateLocalName(clean, null)) return { ok: false, error: 'Ya hay un local con ese nombre.' };
    try {
        await localsCollectionRef().add({
            name: clean,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await reloadAvailableLocals();
        showToast(`Local "${clean}" creado`);
        return { ok: true };
    } catch (err) {
        console.error('[HORAX] Error creando el local:', err);
        return { ok: false, error: localErrorMessage(err, 'No se pudo crear el local. Probá de nuevo.') };
    }
}

async function renameLocal(id, newName) {
    const local = availableLocals.find(l => l.id === id);
    if (!local) return;
    const clean = cleanLocalName(newName);
    if (!clean) { showToast('Escribí un nombre para el local'); return; }
    if (clean.length > 40) { showToast('El nombre puede tener hasta 40 letras'); return; }
    if (clean === local.name) { editingLocalId = null; renderAdminLocalsList(); return; }
    if (isDuplicateLocalName(clean, id)) { showToast('Ya hay un local con ese nombre'); return; }
    try {
        await localDocRef(id).update({ name: clean });
        editingLocalId = null;
        await reloadAvailableLocals();
        showToast('Local renombrado');
    } catch (err) {
        console.error('[HORAX] Error renombrando el local:', err);
        showToast(localErrorMessage(err, 'No se pudo renombrar el local'), 3500);
    }
}

async function deleteLocal(id) {
    const local = availableLocals.find(l => l.id === id);
    if (!local) return;

    // Siempre tiene que quedar al menos un local (si no, el admin se queda sin nada que mostrar)
    if (availableLocals.length <= 1) {
        await showConfirm({
            title: 'No se puede borrar',
            message: 'Tiene que quedar al menos un local. Creá otro antes de borrar este.',
            okText: 'Entendido', hideCancel: true, warn: true
        });
        return;
    }

    // Cuentas asignadas a este local (se vuelve a leer para no usar datos viejos)
    try {
        const snap = await db.collection('users').get();
        adminUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        adminUsersLoaded = true;
    } catch (err) {
        console.error('[HORAX] Error verificando las cuentas del local:', err);
        showToast('No se pudo verificar qué cuentas usan este local', 3500);
        return;
    }
    const assigned = adminUsers.filter(u => u.localId === id);
    if (assigned.length > 0) {
        const lines = assigned.map(u => {
            const nm = (u.profile && [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ').trim()) || '';
            return '• ' + (nm ? `${nm} (${u.email || 'sin mail'})` : (u.email || 'cuenta sin nombre'));
        }).join('\n');
        await showConfirm({
            title: 'No se puede borrar',
            message: `${local.name} todavía tiene cuentas asignadas:\n${lines}\n\nCambiales el local desde la lista de usuarios y probá de nuevo.`,
            okText: 'Entendido', hideCancel: true, warn: true
        });
        return;
    }

    // Cuántas extras se perderían
    let extrasTxt = '';
    try {
        const snap = await localDocRef(id).get();
        const n = (snap.exists && snap.data() && Array.isArray(snap.data().entries)) ? snap.data().entries.length : 0;
        extrasTxt = n > 0 ? ` y sus ${n} ${n === 1 ? 'extra cargada' : 'extras cargadas'}` : '';
    } catch (_) { /* si no se puede leer, se borra igual con el aviso general */ }

    const ok = await showConfirm({
        title: '¿Borrar este local?',
        message: `Se va a borrar ${local.name}${extrasTxt}. Esta acción no se puede deshacer.`,
        okText: 'Borrar local',
        cancelText: 'Cancelar',
        warn: true
    });
    if (!ok) return;

    try {
        // Si es el local que se está mirando, pasamos a otro antes de borrarlo
        if (id === currentLocalId) {
            const other = availableLocals.find(l => l.id !== id);
            if (other) switchLocal(other.id);
        }
        await localDocRef(id).delete();
        if (editingLocalId === id) editingLocalId = null;
        await reloadAvailableLocals();
        showToast(`Local "${local.name}" borrado`);
    } catch (err) {
        console.error('[HORAX] Error borrando el local:', err);
        showToast(localErrorMessage(err, 'No se pudo borrar el local'), 3500);
        try { await reloadAvailableLocals(); } catch (_) {}
    }
}

// ---- Modal "Nuevo local" ----
function openNewLocalModal() {
    const modal = document.getElementById('newLocalModal');
    const input = document.getElementById('newLocalName');
    const errorEl = document.getElementById('newLocalError');
    if (!modal || !input) return;
    input.value = '';
    if (errorEl) errorEl.style.display = 'none';
    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 50);
}
function closeNewLocalModal() {
    const modal = document.getElementById('newLocalModal');
    if (modal) modal.style.display = 'none';
}
async function saveNewLocalFromModal() {
    const input = document.getElementById('newLocalName');
    const errorEl = document.getElementById('newLocalError');
    const saveBtn = document.getElementById('newLocalSaveBtn');
    if (!input || !saveBtn) return;
    saveBtn.disabled = true;
    const res = await createLocal(input.value);
    saveBtn.disabled = false;
    if (!res.ok) {
        if (errorEl) { errorEl.textContent = res.error; errorEl.style.display = 'block'; }
        return;
    }
    closeNewLocalModal();
}

// ---- Editar el rol / local de una cuenta (con confirmación) ----
let editingUserUid = null;
function openEditUserModal(uid) {
    const u = adminUsers.find(x => x.uid === uid);
    if (!u) return;
    editingUserUid = uid;
    const modal = document.getElementById('editUserModal');
    const hint = document.getElementById('editUserHint');
    const roleSel = document.getElementById('editUserRole');
    const localSel = document.getElementById('editUserLocal');
    const errorEl = document.getElementById('editUserError');
    if (!modal || !hint || !roleSel || !localSel || !errorEl) return;
    errorEl.style.display = 'none';

    const name = (u.profile && [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ').trim()) || u.email || 'esta cuenta';
    hint.textContent = `Vas a cambiar el acceso de ${name} (${u.email || 'sin mail'}).`;

    roleSel.value = u.role === 'admin' ? 'admin' : 'encargada';
    const localsSorted = [...availableLocals].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    localSel.innerHTML = localsSorted.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
    localSel.value = availableLocals.some(l => l.id === u.localId) ? u.localId : ((localsSorted[0] && localsSorted[0].id) || '');
    updateEditUserLocalVisibility();

    modal.style.display = 'flex';
}
function updateEditUserLocalVisibility() {
    const roleSel = document.getElementById('editUserRole');
    const group = document.getElementById('editUserLocalGroup');
    if (!roleSel || !group) return;
    group.style.display = roleSel.value === 'encargada' ? 'block' : 'none';
}
function closeEditUserModal() {
    editingUserUid = null;
    const modal = document.getElementById('editUserModal');
    if (modal) modal.style.display = 'none';
}
async function saveEditUserFromModal() {
    if (!editingUserUid) return;
    const u = adminUsers.find(x => x.uid === editingUserUid);
    if (!u) return;
    const roleSel = document.getElementById('editUserRole');
    const localSel = document.getElementById('editUserLocal');
    const errorEl = document.getElementById('editUserError');
    errorEl.style.display = 'none';

    const newRole = roleSel.value;
    const newLocalId = newRole === 'encargada' ? localSel.value : null;
    if (newRole === 'encargada' && !newLocalId) {
        errorEl.textContent = 'Elegí un local para esta cuenta.';
        errorEl.style.display = 'block';
        return;
    }
    const name = (u.profile && [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ').trim()) || u.email || 'esta cuenta';
    const localLabel = newRole === 'encargada' ? ` en ${localNameById(newLocalId)}` : '';
    const ok = await showConfirm({
        title: '¿Confirmar el cambio?',
        message: `${name} va a quedar como ${ROLE_LABEL[newRole]}${localLabel}.`,
        okText: 'Confirmar',
        cancelText: 'Cancelar'
    });
    if (!ok) return;

    const saveBtn = document.getElementById('editUserSaveBtn');
    saveBtn.disabled = true;
    try {
        const payload = { role: newRole };
        if (newRole === 'encargada') payload.localId = newLocalId;
        else payload.localId = firebase.firestore.FieldValue.delete();
        await userDocRef(editingUserUid).update(payload);
        const idx = adminUsers.findIndex(x => x.uid === editingUserUid);
        if (idx !== -1) adminUsers[idx] = { ...adminUsers[idx], role: newRole, localId: newRole === 'encargada' ? newLocalId : null };
        renderAdminUsersList();
        closeEditUserModal();
        showToast('Acceso actualizado');
    } catch (err) {
        console.error('[HORAX] Error actualizando el usuario:', err);
        errorEl.textContent = 'No se pudo guardar el cambio (revisá las reglas de Firestore).';
        errorEl.style.display = 'block';
    } finally {
        saveBtn.disabled = false;
    }
}

function handleSignedOut() {
    currentUser = null;
    userProfile = null;
    currentRole = null;
    currentLocalId = null;
    availableLocals = [];
    adminUsers = [];
    adminUsersLoaded = false;
    applyProfileToHeader();
    closeProfileModal(true);
    overtimeData = [];
    if (userDocUnsubscribe) { userDocUnsubscribe(); userDocUnsubscribe = null; }
    if (localDocUnsubscribe) { localDocUnsubscribe(); localDocUnsubscribe = null; }
    const bar = document.getElementById('localBar');
    if (bar) bar.remove();
    updateAdminTabVisibility();
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = 'none';
    resetLoginCard();
    showLoading(false);
    showLoginScreen(true);
}

// Deja la tarjeta de login como al principio (por si había quedado con el
// formulario de alta automática o el aviso de "sin local" de otra cuenta).
function resetLoginCard() {
    const card = document.querySelector('#loginScreen .login-card');
    if (card && card.innerHTML !== LOGIN_CARD_DEFAULT_HTML) {
        card.innerHTML = LOGIN_CARD_DEFAULT_HTML;
        bindGoogleLoginButton();
    }
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
    { hex: '#4CE5CF', name: 'Turquesa' }
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
    refreshPushUi();
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

function saveData() {
    if (!currentLocalId) return;
    suppressNextSnapshot = true;
    localDocRef(currentLocalId)
        .set({ entries: overtimeData }, { merge: true })
        .catch(err => {
            console.error('[HORAX] Error guardando en la nube:', err);
            showToast('No se pudo guardar en la nube (sin conexión)');
        });
    updateBadges();
}
// ============================================================
//  HISTORIAL DE AUDITORÍA
//  Quién agregó, editó o borró una extra, y cuándo.
//
//  Se guarda en locals/{localId}/auditLog/{autoId} — una SUBCOLECCIÓN,
//  no un array paralelo dentro del documento del local. Motivo: `entries`
//  ya vive como array en ese documento y cada guardado (saveData) reescribe
//  el array completo; si el auditLog fuera otro array en el mismo doc,
//  cada nuevo evento obligaría a reescribir TODO el historial acumulado,
//  y ese documento (que tiene un límite de 1 MiB en Firestore) crecería
//  para siempre con la actividad, sin forma de acotarlo. Como subcolección,
//  cada evento es un documento chico e independiente: se agrega con `.add()`
//  sin tocar `entries` ni el resto del historial, no hay límite de tamaño
//  práctico, y se puede paginar/ordenar por fecha con una query normal.
function auditActor() {
    const name = profileDisplayName() || (currentUser && currentUser.displayName) || 'Alguien';
    const email = (currentUser && currentUser.email) || '';
    return { name, email };
}
// action: 'create' | 'update' | 'delete'. summary: texto legible para mostrar
// en el historial. entryId: id de la extra afectada (o null para acciones
// masivas como importar/deshacer/vaciar todo).
function logAudit(action, summary, entryId) {
    if (!currentLocalId) return;
    const actor = auditActor();
    auditLogRef(currentLocalId).add({
        action,
        summary,
        entryId: entryId != null ? entryId : null,
        byName: actor.name,
        byEmail: actor.email,
        at: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(err => console.error('[HORAX] Error guardando auditoría:', err));
}
function fmtDM(dateStr) {
    const [, m, d] = dateStr.split('-');
    return `${d}/${m}`;
}
function buildEditSummary(before, after) {
    const parts = [];
    const dateChanged = before.date !== after.date;
    const timeChanged = before.start !== after.start || before.end !== after.end;
    if (dateChanged || timeChanged) {
        if (dateChanged) {
            parts.push(`el horario de ${after.person} del ${fmtDM(before.date)} ${before.start}-${before.end} a ${fmtDM(after.date)} ${after.start}-${after.end}`);
        } else {
            parts.push(`el horario de ${after.person} del ${fmtDM(after.date)} de ${before.start}-${before.end} a ${after.start}-${after.end}`);
        }
    }
    if (before.person !== after.person) parts.push(`la persona de ${before.person} a ${after.person}`);
    if ((before.comment || '') !== (after.comment || '')) parts.push('el comentario');
    if (parts.length === 0) return `Editó una extra de ${after.person} sin cambios de datos`;
    return `Cambió ${parts.join(', ')}`;
}

function currentLocalName() {
    const found = availableLocals.find(l => l.id === currentLocalId);
    return found ? found.name : (currentLocalId || 'este local');
}
// Borra todas las extras del MES DEL CALENDARIO que se está viendo.
// Es lo que una encargada realmente quiere: "me equivoqué cargando este mes".
async function clearMonth() {
    if (!currentLocalId) return;

    const monthName = new Date(currentYear, currentMonth, 1)
        .toLocaleDateString('es-ES', { month: 'long' });
    const monthCap = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const toDelete = getEntriesForMonth(currentYear, currentMonth);
    if (toDelete.length === 0) {
        showToast(`No hay extras cargadas en ${monthCap}`);
        return;
    }

    const ok = await showConfirm({
        title: `¿Borrar las extras de ${monthCap}?`,
        message: `Se van a borrar ${toDelete.length} ${toDelete.length === 1 ? 'extra' : 'extras'} de ${monthCap} ${currentYear} en ${currentLocalName()}. Esta acción no se puede deshacer.`,
        okText: `Borrar ${monthCap}`,
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;

    overtimeData = overtimeData.filter(e =>
        !(e.date.startsWith(`${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`))
    );
    saveData(); renderAll();
    showToast(`${monthCap} borrado`);
    logAudit('delete', `Borró todas las extras de ${monthCap} ${currentYear} (${toDelete.length})`, null);
}

// Borra TODO el histórico del local. Solo desde el panel Admin.
async function clearAllData() {
    if (!currentLocalId) return;
    const total = overtimeData.length;
    if (total === 0) {
        showToast('No hay extras cargadas');
        return;
    }
    const ok = await showConfirm({
        title: '¿Vaciar TODO el local?',
        message: `Se van a borrar las ${total} extras cargadas en ${currentLocalName()}, de TODOS los meses. Esta acción no se puede deshacer.`,
        okText: 'Sí, borrar todo',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    overtimeData = [];
    employeeColorsCache.clear();
    saveData(); renderAll();
    showToast('Local vaciado');
    logAudit('delete', `Vació TODAS las extras del local (${total})`, null);
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
// Evita que un comentario con < > & rompa el HTML del listado del día
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    const entry = overtimeData.find(e => e.id === id);
    overtimeData = overtimeData.filter(e => e.id !== id);
    saveData(); renderAll(); showToast('Extra eliminada');
    if (entry) {
        logAudit('delete', `Eliminó la extra de ${entry.person} del ${fmtDM(entry.date)} (${entry.start}-${entry.end})`, id);
    }
}
function addEntry(date, start, end, person, comment) {
    const maxId = overtimeData.reduce((m, e) => Math.max(m, e.id), 0);
    const entry = { id: maxId + 1, date, start, end, person: person.trim(), done: false, comment: (comment || '').trim() };
    overtimeData.push(entry);
    saveData(); renderAll(); showToast(`Extra agregada para ${person}`);
    logAudit('create', `Agregó una extra para ${entry.person} el ${fmtDM(date)} de ${start} a ${end}`, entry.id);
}
function editEntry(id, date, start, end, person, comment) {
    const entry = overtimeData.find(e => e.id === id);
    if (!entry) return;
    const before = { date: entry.date, start: entry.start, end: entry.end, person: entry.person, comment: entry.comment };
    entry.date = date; entry.start = start; entry.end = end; entry.person = person.trim();
    entry.comment = (comment || '').trim();
    saveData(); renderAll(); showToast('Extra actualizada');
    logAudit('update', buildEditSummary(before, entry), id);
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
    const editComment = document.getElementById('editComment');
    if (editComment) editComment.value = entry.comment || '';
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
    const commentEl = document.getElementById('editComment');
    const comment = commentEl ? commentEl.value.trim() : '';
    if (!date || !start || !end || !person) { showToast('Completá todos los campos'); return; }
    if (start >= end) { showToast('El inicio debe ser anterior al final'); return; }
    editEntry(editingEntryId, date, start, end, person, comment);
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
    const allOTDates = new Set(overtimeData.map(e => e.date)); // para los días grises de meses vecinos
    const otherCls = ds => {
        if (!allOTDates.has(ds)) return 'day-cell other-month';
        const st = getDayStatus(ds);
        return 'day-cell other-month has-overtime' + (st === 'done' ? ' done' : st === 'pending' ? ' pending' : '');
    };

    let html = '';
    for (const n of ['L','M','M','J','V','S','D']) html += `<div class="day-name">${n}</div>`;

    const startOffset = firstDay === 0 ? 6 : firstDay - 1;
    for (let i = startOffset - 1; i >= 0; i--) {
        const day = daysInPrev - i;
        const dateObj = new Date(currentYear, currentMonth - 1, day);
        const ds = formatDate(dateObj);
        html += `<button class="${otherCls(ds)}" data-date="${ds}">${day}</button>`;
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
        const ds = formatDate(dateObj);
        html += `<button class="${otherCls(ds)}" data-date="${ds}">${d}</button>`;
    }
    grid.innerHTML = html;
    renderTodayBarCalendar();

    grid.querySelectorAll('.day-cell').forEach(el => {
        el.addEventListener('click', () => {
            const date = el.dataset.date;
            if (!date) return;
            selectedDate = date;
            // tocar un día gris te lleva a ese mes
            if (el.classList.contains('other-month')) {
                const [yy, mm] = date.split('-').map(Number);
                currentYear = yy; currentMonth = mm - 1;
            }
            renderCalendar();
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
                    <div class="ot-person" style="color:${color};">${escapeHtml(e.person)}</div>
                    <div class="ot-time">${e.start} - ${e.end}</div>
                    ${e.comment ? `<div class="ot-comment"><i class="fas fa-comment-dots"></i> ${escapeHtml(e.comment)}</div>` : ''}
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
        el.addEventListener('click', async ev => {
            ev.stopPropagation();
            const id = parseInt(el.dataset.id, 10);
            const ok = await showConfirm({
                title: '¿Eliminar esta extra?',
                message: 'Esta acción no se puede deshacer.',
                okText: 'Eliminar',
                cancelText: 'Cancelar',
                danger: true
            });
            if (ok) deleteEntry(id);
        });
    });
}

// ============================================================
//  RESUMEN: período de cierre del día 26 del mes anterior al día 25
//  (ej. Septiembre = 26 ago → 25 sep; el día 25 cuenta en el mes que cierra)
// ============================================================
const CIERRE_DIA = 25;

// ★ El Resumen tiene su PROPIO período, independiente del mes del Calendario.
// Así, a partir del día 26 el Resumen abre en el período que está corriendo
// (ej. hoy 29 sep → "Octubre" = 26 sep al 25 oct) mientras el Calendario sigue
// mostrando el mes real, donde se ven las extras de hoy.
let summaryYear = hoyMVD().year;
let summaryMonth = hoyMVD().month;

// Período de cierre en el que cae HOY
function currentCyclePeriod() {
    const h = hoyMVD();
    if (h.day > CIERRE_DIA) return h.month === 11 ? { year: h.year + 1, month: 0 } : { year: h.year, month: h.month + 1 };
    return { year: h.year, month: h.month };
}
function goToCurrentPeriod() {
    const p = currentCyclePeriod();
    summaryYear = p.year; summaryMonth = p.month;
    renderSummary();
    updateBadges();
}

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
    const r = getSummaryRange(summaryYear, summaryMonth);
    return overtimeData.filter(e => e.date >= r.start && e.date <= r.end);
}
function entryHours(e) {
    const [sh, sm] = e.start.split(':').map(Number);
    const [eh, em] = e.end.split(':').map(Number);
    return Math.max(0, ((eh * 60 + em) - (sh * 60 + sm)) / 60);
}
function fmtHours(h) { return String(Math.round(h * 100) / 100).replace('.', ','); }
function shiftSummary(delta) {
    summaryMonth += delta;
    if (summaryMonth < 0) { summaryMonth = 11; summaryYear--; }
    if (summaryMonth > 11) { summaryMonth = 0; summaryYear++; }
    renderSummary();
    updateBadges();
}

// Volver directo al mes actual (según Montevideo), sin importar cuánto te hayas alejado
function isCurrentMonthShown() {
    const h = hoyMVD();
    return currentYear === h.year && currentMonth === h.month;
}
// Barra "Volver al mes actual": solo aparece cuando NO estás en el mes actual
function todayBarHtml() {
    if (isCurrentMonthShown()) return '';
    const h = hoyMVD();
    const name = new Date(h.year, h.month, 1).toLocaleDateString('es-ES', { month: 'long' });
    const label = name.charAt(0).toUpperCase() + name.slice(1) + ' ' + h.year;
    return `<button type="button" class="today-bar" title="Volver al mes actual">
        <i class="fas fa-rotate-left"></i> Volver al mes actual <strong>(${label})</strong></button>`;
}
// Barra del Resumen: aparece cuando NO estás viendo el período en curso
function summaryTodayBarHtml() {
    const p = currentCyclePeriod();
    if (summaryYear === p.year && summaryMonth === p.month) return '';
    const name = new Date(p.year, p.month, 1).toLocaleDateString('es-ES', { month: 'long' });
    const label = name.charAt(0).toUpperCase() + name.slice(1) + ' ' + p.year;
    return `<button type="button" class="today-bar" data-scope="summary" title="Volver al período actual">
        <i class="fas fa-rotate-left"></i> Volver al período actual <strong>(${label})</strong></button>`;
}
// En el Calendario la barra vive en un contenedor que se crea debajo del selector de mes
function renderTodayBarCalendar() {
    const nav = document.getElementById('monthLabel').closest('.month-nav');
    let box = document.getElementById('todayBarCal');
    if (!box) {
        box = document.createElement('div');
        box.id = 'todayBarCal';
        nav.insertAdjacentElement('afterend', box);
    }
    box.innerHTML = todayBarHtml();
}
function goToToday() {
    const h = hoyMVD();
    currentYear = h.year;
    currentMonth = h.month;
    selectedDate = formatDate(hoyDate());
    renderCalendar();
}

// Personas desplegadas en el Resumen
const expandedPeople = new Set();
let summaryRows = [];

// Buscador y filtro del Resumen (se mantienen al cambiar de mes)
let summaryFilter = '';
let hideDone = false;
function normalizeText(t) {
    return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function renderSummary() {
    summaryRows = [];
    const container = document.getElementById('summaryContainer');
    const range = getSummaryRange(summaryYear, summaryMonth);
    const monthName = new Date(summaryYear, summaryMonth, 1)
        .toLocaleDateString('es-ES', { month: 'long' });
    const fmtDay = d => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });

    let html = `
        <div class="month-nav">
            <button id="summaryPrev"><i class="fas fa-chevron-left"></i></button>
            <span class="month-label">${monthName.charAt(0).toUpperCase() + monthName.slice(1)} <small>${summaryYear}</small></span>
            <button id="summaryNext"><i class="fas fa-chevron-right"></i></button>
        </div>
        ${summaryTodayBarHtml()}
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
        const summaryAll = Array.from(byPerson.values())
            .sort((a, b) => b.total - a.total || a.person.localeCompare(b.person, 'es'));

        // Filtros: texto buscado y "Ocultar ya hechas"
        const q = normalizeText(summaryFilter.trim());
        const filterOn = q !== '' || hideDone;
        const summary = summaryAll.filter(row => {
            if (q && !normalizeText(row.person).includes(q)) return false;
            if (hideDone && row.items.every(e => e.done)) return false;
            return true;
        });

        summaryRows = summary;
        if (summary.length === 0) {
            html += `<div class="empty-state"><i class="fas fa-magnifying-glass"></i><p>No hay coincidencias</p></div>`;
        } else {
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
                <td class="person-name" style="color:${color};"><i class="fas fa-chevron-right sum-arrow"></i>${escapeHtml(row.person)}</td>
                <td>${fmtHours(row.total)}</td>
                <td><span class="badge badge-done">${fmtHours(row.done)}</span></td>
                <td><span class="badge badge-pending">${fmtHours(row.total - row.done)}</span></td>
            </tr>`;
            const items = row.items.filter(e => !(hideDone && e.done)).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
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
                <td>${filterOn ? 'Total (filtrado)' : 'Total'}</td>
                <td>${fmtHours(sumTotal)}</td>
                <td>${fmtHours(sumDone)}</td>
                <td>${fmtHours(sumTotal - sumDone)}</td>
            </tr>`;
        html += `</tbody></table></div>`;
        }
    }
    container.innerHTML = html;

    // El buscador solo se muestra si el período tiene extras
    const filterBar = document.getElementById('summaryFilterBar');
    if (filterBar) filterBar.style.display = entries.length > 0 ? 'flex' : 'none';

    // ★ NUEVO (#5): mostrar u ocultar los botones de exportar según si hay datos
    const exportRow = document.getElementById('exportRow');
    if (exportRow) exportRow.style.display = entries.length > 0 ? 'flex' : 'none';

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

// ---- Ver historial de auditoría (solo lectura: no hay ningún botón de
// editar/borrar en este modal, y la app nunca escribe en auditLog salvo
// desde logAudit) ----
const AUDIT_ICON = { create: 'fa-plus', update: 'fa-pen', delete: 'fa-trash-alt' };
function openAuditModal() {
    const modal = document.getElementById('auditModal');
    if (!modal || !currentLocalId) return;
    modal.style.display = 'flex';
    const list = document.getElementById('auditList');
    list.innerHTML = `<div class="empty-state"><i class="fas fa-circle-notch fa-spin"></i><p>Cargando historial...</p></div>`;
    auditLogRef(currentLocalId).orderBy('at', 'desc').limit(200).get()
        .then(snap => renderAuditList(snap.docs))
        .catch(err => {
            console.error('[HORAX] Error leyendo auditoría:', err);
            list.innerHTML = `<div class="empty-state"><i class="fas fa-triangle-exclamation"></i><p>No se pudo cargar el historial</p></div>`;
        });
}
function closeAuditModal() {
    const modal = document.getElementById('auditModal');
    if (modal) modal.style.display = 'none';
}
function renderAuditList(docs) {
    const list = document.getElementById('auditList');
    if (!list) return;
    if (!docs || docs.length === 0) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-clock-rotate-left"></i><p>Todavía no hay actividad registrada</p></div>`;
        return;
    }
    list.innerHTML = docs.map(doc => {
        const d = doc.data();
        const icon = AUDIT_ICON[d.action] || 'fa-circle-info';
        const when = (d.at && d.at.toDate) ? d.at.toDate().toLocaleString('es-UY', {
            timeZone: 'America/Montevideo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        }) : 'justo ahora';
        return `<div class="audit-item audit-${d.action}">
            <div class="audit-icon"><i class="fas ${icon}"></i></div>
            <div class="audit-body">
                <p class="audit-summary">${escapeHtml(d.summary || '')}</p>
                <p class="audit-meta">${escapeHtml(d.byName || d.byEmail || 'Alguien')} · ${when}</p>
            </div>
        </div>`;
    }).join('');
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

// ============================================================
//  ★ NUEVO (#5): EXPORTAR RESUMEN (CSV / PDF)
// ============================================================

// Arma el CSV del período del Resumen que se está viendo
function buildSummaryCsv() {
    const entries = getEntriesForSummary();
    if (entries.length === 0) return null;

    const range = getSummaryRange(summaryYear, summaryMonth);
    const monthName = new Date(summaryYear, summaryMonth, 1)
        .toLocaleDateString('es-ES', { month: 'long' });
    const monthLabel = monthName.charAt(0).toUpperCase() + monthName.slice(1) + '_' + summaryYear;

    // Ordenado por persona y después por fecha/hora
    const sorted = [...entries].sort((a, b) =>
        a.person.localeCompare(b.person, 'es') ||
        a.date.localeCompare(b.date) ||
        a.start.localeCompare(b.start)
    );

    const rows = [['Persona', 'Fecha', 'Día', 'Desde', 'Hasta', 'Horas', 'Estado', 'Comentario']];
    for (const e of sorted) {
        rows.push([
            e.person,
            e.date,
            getDayName(e.date),
            e.start,
            e.end,
            fmtHours(entryHours(e)),   // ya devuelve con coma decimal
            e.done ? 'Hecha' : 'Pendiente',
            e.comment || ''
        ]);
    }
    const totalHours = entries.reduce((s, e) => s + entryHours(e), 0);
    rows.push([]);
    rows.push(['TOTAL', '', '', '', '', fmtHours(totalHours), '', '']);

    const csv = rows.map(r => r.map(csvCell).join(';')).join('\r\n');

    return {
        csv,
        filename: `HORAX_Resumen_${monthLabel}.csv`,
        rangeStart: range.start,
        rangeEnd: range.end
    };
}

// Escapa una celda de CSV: si tiene ; " o saltos de línea, la envuelve en comillas
function csvCell(v) {
    const s = String(v == null ? '' : v);
    if (/[;"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

// Fuerza la descarga de un archivo desde el navegador
function downloadFile(filename, content, mime) {
    // El \uFEFF es un "BOM" para que Excel abra bien los acentos
    const blob = new Blob(['\uFEFF' + content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Comparte el CSV con el menú nativo del celu (WhatsApp, mail, etc.)
// Devuelve true si lo pudo compartir, false si no (para caer al download normal)
async function tryShareCsv(info) {
    if (!navigator.share || !navigator.canShare) return false;
    try {
        const file = new File(['\uFEFF' + info.csv], info.filename, { type: 'text/csv' });
        if (!navigator.canShare({ files: [file] })) return false;
        await navigator.share({
            files: [file],
            title: 'Resumen HORAX',
            text: `Resumen de horas extras (${info.rangeStart} al ${info.rangeEnd})`
        });
        return true;
    } catch (err) {
        if (err && err.name === 'AbortError') return true; // el usuario canceló, no es error
        console.warn('[HORAX] No se pudo compartir, se descarga como archivo:', err);
        return false;
    }
}

async function exportSummaryCsv() {
    const info = buildSummaryCsv();
    if (!info) { showToast('No hay datos para exportar'); return; }
    // En el celu primero probamos el menú "compartir con…"
    if (await tryShareCsv(info)) return;
    // Si no, descarga directa
    downloadFile(info.filename, info.csv, 'text/csv');
    showToast('Descargando CSV…');
}

// Genera un PDF lindo del Resumen (con colores) y lo comparte o descarga
async function exportSummaryPdf() {
    const entries = getEntriesForSummary();
    if (entries.length === 0) { showToast('No hay datos para exportar'); return; }
    if (typeof html2pdf === 'undefined') {
        showToast('No se pudo cargar el generador de PDF. Revisá la conexión.', 3500);
        return;
    }

    const range = getSummaryRange(summaryYear, summaryMonth);
    const monthRaw = new Date(summaryYear, summaryMonth, 1).toLocaleDateString('es-ES', { month: 'long' });
    const monthCap = monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1);
    const fmtDay = d => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
    const fmtShort = s => { const p = s.split('-'); return p[2] + '/' + p[1]; };
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

    // Agrupar por persona
    const byPerson = new Map();
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    for (const e of sorted) {
        const p = byPerson.get(e.person) || { person: e.person, total: 0, done: 0, items: [] };
        const h = entryHours(e);
        p.total += h;
        if (e.done) p.done += h;
        p.items.push(e);
        byPerson.set(e.person, p);
    }
    const people = Array.from(byPerson.values())
        .sort((a, b) => b.total - a.total || a.person.localeCompare(b.person, 'es'));

    const totalAll = people.reduce((s, p) => s + p.total, 0);
    const doneAll = people.reduce((s, p) => s + p.done, 0);
    const pendAll = totalAll - doneAll;
    const pctAll = totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : 0;

    const palette = ['#6C63FF', '#10B981', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899', '#14B8A6', '#8B5CF6'];

    // Tabla resumen (página 1)
    let summaryRows = '';
    people.forEach((p, i) => {
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        const color = palette[i % palette.length];
        summaryRows += `
            <tr>
                <td style="width:34%;"><span class="hx-dot" style="background:${color};"></span>${escapeHtml(p.person)}</td>
                <td class="hx-num">${fmtHours(p.total)} h</td>
                <td class="hx-num hx-ok">${fmtHours(p.done)} h</td>
                <td class="hx-num hx-warn">${fmtHours(p.total - p.done)} h</td>
                <td style="width:22%;">
                    <div class="hx-track"><div class="hx-fill" style="width:${pct}%;background:${color};"></div></div>
                </td>
            </tr>`;
    });

    // Detalle por persona (página 2 en adelante)
    let detail = '';
    people.forEach((p, i) => {
        const color = palette[i % palette.length];
        const initial = escapeHtml((p.person.trim().charAt(0) || '?').toUpperCase());
        let rows = '';
        for (const e of p.items) {
            const st = e.done
                ? '<span class="hx-chip hx-chip-ok">Hecha</span>'
                : '<span class="hx-chip hx-chip-pend">Pendiente</span>';
            rows += `
                <tr>
                    <td style="width:16%;">${fmtShort(e.date)}</td>
                    <td style="width:20%;">${escapeHtml(cap(getDayName(e.date)))}</td>
                    <td style="width:22%;">${e.start} – ${e.end}</td>
                    <td class="hx-num" style="width:12%;">${fmtHours(entryHours(e))} h</td>
                    <td style="width:16%;">${st}</td>
                    <td class="hx-com">${escapeHtml(e.comment || '')}</td>
                </tr>`;
        }
        detail += `
            <div class="hx-person">
                <div class="hx-phead" style="border-left:5px solid ${color};">
                    <div class="hx-avatar" style="background:${color};">${initial}</div>
                    <div class="hx-pname">${escapeHtml(p.person)}</div>
                    <div class="hx-ptotal">${fmtHours(p.total)} h</div>
                </div>
                <table class="hx-detail">${rows}</table>
            </div>`;
    });

    const now = new Date().toLocaleString('es-UY', {
        timeZone: 'America/Montevideo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });

    const html = `
        <style>
            .hx-pdf { width:720px; background:#fff; color:#1A1A2E; font-family:'Inter',-apple-system,'Segoe UI',Arial,sans-serif; font-size:12px; }
            .hx-pdf * { box-sizing:border-box; }
            .hx-hero { background:linear-gradient(135deg,#6C63FF 0%,#8B5CF6 100%); color:#fff; border-radius:16px; padding:26px 28px; }
            .hx-brand { font-size:13px; font-weight:700; letter-spacing:4px; opacity:.85; }
            .hx-title { font-size:26px; font-weight:700; margin:6px 0 4px; }
            .hx-sub { font-size:12px; opacity:.9; }
            .hx-kpis { display:flex; gap:12px; margin:16px 0 22px; }
            .hx-kpi { flex:1; border-radius:12px; padding:14px 16px; border:1px solid #E5E7EB; background:#F9FAFB; }
            .hx-kpi-n { font-size:24px; font-weight:700; }
            .hx-kpi-l { font-size:10px; letter-spacing:1px; text-transform:uppercase; color:#6B7280; margin-top:2px; }
            .hx-h3 { font-size:14px; font-weight:700; margin:0 0 10px; color:#1A1A2E; }
            .hx-pdf table { width:100%; border-collapse:collapse; }
            .hx-sum th { background:#F0EFFF; color:#4B44CC; text-align:left; padding:10px 10px; font-size:10px; letter-spacing:1px; text-transform:uppercase; }
            .hx-sum td { padding:11px 10px; border-bottom:1px solid #F3F4F6; font-weight:500; }
            .hx-sum tr.hx-tot td { background:#F0EFFF; font-weight:700; border-bottom:none; }
            .hx-num { text-align:right; white-space:nowrap; }
            .hx-ok { color:#059669; }
            .hx-warn { color:#D97706; }
            .hx-dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:8px; }
            .hx-track { height:8px; background:#E5E7EB; border-radius:4px; overflow:hidden; }
            .hx-fill { height:8px; border-radius:4px; }
            .hx-break { page-break-before:always; padding-top:4px; }
            .hx-person { margin-bottom:18px; page-break-inside:avoid; }
            .hx-phead { display:flex; align-items:center; background:#F9FAFB; border-radius:10px; padding:10px 14px; margin-bottom:4px; }
            .hx-avatar { width:28px; height:28px; border-radius:50%; color:#fff; font-weight:700; text-align:center; line-height:28px; margin-right:10px; }
            .hx-pname { flex:1; font-size:14px; font-weight:700; }
            .hx-ptotal { font-size:14px; font-weight:700; color:#6C63FF; }
            .hx-detail td { padding:8px 10px; border-bottom:1px solid #F3F4F6; font-size:11.5px; }
            .hx-com { color:#6B7280; font-size:10.5px; }
            .hx-chip { display:inline-block; padding:3px 9px; border-radius:20px; font-size:10px; font-weight:600; }
            .hx-chip-ok { background:#D1FAE5; color:#047857; }
            .hx-chip-pend { background:#FEF3C7; color:#B45309; }
            .hx-foot { margin-top:18px; text-align:right; font-size:10px; color:#9CA3AF; }
        </style>
        <div class="hx-pdf">
            <div class="hx-hero">
                <div class="hx-brand">HORAX</div>
                <div class="hx-title">Resumen de horas extras · ${escapeHtml(monthCap)} ${summaryYear}</div>
                <div class="hx-sub">${escapeHtml(currentLocalName())} · Del ${fmtDay(range.startDate)} al ${fmtDay(range.endDate)}</div>
            </div>

            <div class="hx-kpis">
                <div class="hx-kpi"><div class="hx-kpi-n" style="color:#6C63FF;">${fmtHours(totalAll)} h</div><div class="hx-kpi-l">Total</div></div>
                <div class="hx-kpi"><div class="hx-kpi-n" style="color:#059669;">${fmtHours(doneAll)} h</div><div class="hx-kpi-l">Hechas (${pctAll}%)</div></div>
                <div class="hx-kpi"><div class="hx-kpi-n" style="color:#D97706;">${fmtHours(pendAll)} h</div><div class="hx-kpi-l">Pendientes</div></div>
                <div class="hx-kpi"><div class="hx-kpi-n">${people.length}</div><div class="hx-kpi-l">Personas</div></div>
            </div>

            <div class="hx-h3">Resumen por persona</div>
            <table class="hx-sum">
                <thead><tr>
                    <th>Persona</th><th style="text-align:right;">Total</th><th style="text-align:right;">Hechas</th><th style="text-align:right;">Pendientes</th><th>Avance</th>
                </tr></thead>
                <tbody>
                    ${summaryRows}
                    <tr class="hx-tot">
                        <td>TOTAL</td>
                        <td class="hx-num">${fmtHours(totalAll)} h</td>
                        <td class="hx-num">${fmtHours(doneAll)} h</td>
                        <td class="hx-num">${fmtHours(pendAll)} h</td>
                        <td></td>
                    </tr>
                </tbody>
            </table>

            <div class="hx-break">
                <div class="hx-h3">Detalle por persona</div>
                ${detail}
                <div class="hx-foot">Generado el ${now}</div>
            </div>
        </div>`;

    // Contenedor temporal (tiene que estar en pantalla para que se dibuje bien)
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;top:0;left:0;z-index:-9999;background:#fff;';
    holder.innerHTML = html;
    document.body.appendChild(holder);

    const filename = `HORAX_Resumen_${monthCap}_${summaryYear}.pdf`;
    showToast('Generando PDF…', 4000);

    try {
        const worker = html2pdf().set({
            margin: [10, 10, 14, 10],
            filename,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0 },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['css', 'legacy'], avoid: ['.hx-person', 'tr'] }
        }).from(holder.querySelector('.hx-pdf'));

        const blob = await worker.toPdf().get('pdf').then(pdf => {
            const total = pdf.internal.getNumberOfPages();
            const w = pdf.internal.pageSize.getWidth();
            const h = pdf.internal.pageSize.getHeight();
            pdf.setFontSize(9);
            pdf.setTextColor(156, 163, 175);
            for (let i = 1; i <= total; i++) {
                pdf.setPage(i);
                pdf.text('HORAX', 10, h - 7);
                pdf.text(`Página ${i} de ${total}`, w - 10, h - 7, { align: 'right' });
            }
            return pdf.output('blob');
        });

        // En el celu: menú "compartir"; si no se puede, descarga directa
        try {
            const file = new File([blob], filename, { type: 'application/pdf' });
            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'Resumen HORAX' });
                return;
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            console.warn('[HORAX] No se pudo compartir, se descarga:', err);
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('PDF listo');
    } catch (err) {
        console.error('[HORAX] Error generando PDF:', err);
        showToast('No se pudo generar el PDF', 3500);
    } finally {
        holder.remove();
    }
}

function renderAll() {
    renderCalendar();
    renderSummary();
    const datalist = document.getElementById('personList');
    if (datalist) datalist.innerHTML = getPeople().map(p => `<option value="${escapeHtml(p)}">`).join('');
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

// ============================================================
//  CONFIRMACIÓN "LINDA" (reemplaza los confirm() feos del navegador)
// ============================================================
// Uso: const ok = await showConfirm({ title, message, okText, cancelText, danger });
function showConfirm({ title = '¿Estás seguro?', message = '', okText = 'Confirmar', cancelText = 'Cancelar', danger = false, warn = false, hideCancel = false } = {}) {
    return new Promise(resolve => {
        const modal = document.getElementById('confirmModal');
        if (!modal) { resolve(window.confirm(message || title)); return; }

        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMessage').textContent = message;
        const icon = document.getElementById('confirmIcon');
        if (icon) {
            icon.classList.toggle('danger', danger);
            icon.innerHTML = danger ? '<i class="fas fa-trash-alt"></i>' : '<i class="fas fa-triangle-exclamation"></i>';
        }
        const okBtn = document.getElementById('confirmOkBtn');
        const cancelBtn = document.getElementById('confirmCancelBtn');
        okBtn.textContent = okText;
        cancelBtn.textContent = cancelText;
        okBtn.classList.toggle('btn-danger', danger);
        okBtn.classList.toggle('btn-warn', warn);
        cancelBtn.style.display = hideCancel ? 'none' : '';
        modal.style.display = 'flex';

        function cleanup(result) {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        }
        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }
        function onOverlay(ev) { if (ev.target.id === 'confirmModal') cleanup(false); }
        function onKey(ev) { if (ev.key === 'Escape') cleanup(false); }

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKey);
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    const t = document.getElementById(tabId); if (t) t.classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    const b = document.querySelector(`.tab-btn[data-tab="${tabId}"]`); if (b) b.classList.add('active');
    currentTab = tabId;
    if (tabId === 'tabSummary') renderSummary();
    if (tabId === 'tabCalendar') renderCalendar();
    if (tabId === 'tabAdmin') renderAdminPanel();
    if (tabId === 'tabAdd') {
        // Si venís de un día elegido en el Calendario, "Agregar" arranca en ese
        // día en vez de siempre en hoy.
        const addDate = document.getElementById('addDate');
        if (addDate) addDate.value = selectedDate || formatDate(hoyDate());
    }
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
    const regularCells = []; // ★ NUEVO: celdas normales (no grises), para la regla de las 8 hs

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

            if (!colorInfo) continue;

            // ★ NUEVO: las celdas normales (no grises) ya no se descartan: se guardan
            // para contar cuántas horas normales tiene cada persona en el día.
            if (!colorInfo.isGray) {
                regularCells.push({
                    date: formatDate(new Date(col.year, col.month, col.day)),
                    start: row.start, end: row.end, person: name
                });
                continue;
            }
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

    // ★ NUEVO: pasadas las 8 hs normales en un mismo día, lo que sigue es extra.
    entries.push(...overflowExtrasFromRegularCells(regularCells));
    dbg.autoExtras = entries.filter(e => e.auto).length;

    return { entries, dbg, zones, missingGrayCells };
}

// ============================================================
//  ★ REGLA DE LAS 8 HORAS
//  Si una persona tiene más de 8 hs NORMALES (celdas no grises) en el mismo
//  día, desde la 9na hora en adelante se convierte automáticamente en extra.
//  Las horas que ya vienen grises no cuentan para las 8 (ya son extras).
// ============================================================
const MAX_REGULAR_HOURS_PER_DAY = 8;

function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToTime(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }

function overflowExtrasFromRegularCells(cells) {
    const limit = MAX_REGULAR_HOURS_PER_DAY * 60;
    const groups = new Map();
    for (const c of cells) {
        const key = `${c.date}|${c.person}`;
        if (!groups.has(key)) groups.set(key, new Map());
        groups.get(key).set(c.start, c); // mismo inicio repetido = misma celda
    }
    const extras = [];
    for (const byStart of groups.values()) {
        const list = [...byStart.values()].sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
        let acc = 0; // minutos normales acumulados en el día
        for (const c of list) {
            const s = timeToMin(c.start), e = timeToMin(c.end);
            const dur = Math.max(0, e - s);
            if (dur === 0) continue;
            if (acc >= limit) {
                extras.push({ date: c.date, start: c.start, end: c.end, person: c.person, done: false, auto: true });
            } else if (acc + dur > limit) {
                // la celda cruza el límite: solo el tramo que pasa de las 8 hs es extra
                extras.push({ date: c.date, start: minToTime(e - (acc + dur - limit)), end: c.end, person: c.person, done: false, auto: true });
            }
            acc += dur;
        }
    }
    return extras;
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
                if (!e.auto) delete current.auto;
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
        .map(p => `<span class="person-chip" style="background:${getEmployeeColor(p)};">${escapeHtml(p)}</span>`)
        .join('');

    const previewList = entries.slice(0, 40);
    document.getElementById('pdfExtrasList').innerHTML =
        previewList.map(e => {
            const c = getEmployeeColor(e.person);
            return `<span class="extra-chip" style="border-left-color:${c};">
                ${formatDateDisplay(e.date)} · ${escapeHtml(e.person)} · ${e.start}-${e.end}${e.auto ? ' · (+8 hs)' : ''}</span>`;
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
async function undoLastImport() {
    const info = getLastImportInfo();
    if (!info) return;
    const ok = await showConfirm({
        title: '¿Deshacer la importación?',
        message: `Se van a borrar ${info.count} ${info.count === 1 ? 'extra' : 'extras'}.`,
        okText: 'Deshacer',
        cancelText: 'Cancelar',
        danger: true
    });
    if (!ok) return;
    overtimeData = overtimeData.filter(e => e.importId !== info.id);
    saveData(); renderAll();
    showToast('Importación deshecha');
    logAudit('delete', `Deshizo una importación de ${info.count} ${info.count === 1 ? 'extra' : 'extras'}`, null);
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
        end: item.end, person: item.person, done: false, importId,
        comment: item.auto ? 'Auto: pasó de las 8 hs del día' : ''
    }));
    overtimeData = overtimeData.concat(newEntries);
    saveData();
    renderAll();
    showToast(`Importadas ${newEntries.length} extras` + (skipped ? ` (${skipped} ya estaban)` : '') + (newEntries.length ? ' · podés deshacer en Importar' : ''), newEntries.length ? 4500 : 2400);
    if (newEntries.length > 0) {
        logAudit('create', `Importó ${newEntries.length} ${newEntries.length === 1 ? 'extra' : 'extras'} desde PDF/foto`, null);
    }
    document.getElementById('pdfPreview').style.display = 'none';
    pdfParsedData = null;

    if (newEntries.length > 0) {
        const [y, m] = newEntries[0].date.split('-').map(Number);
        currentYear = y; currentMonth = m - 1;
        const pr = getClosingPeriodOf(newEntries[0].date);
        summaryYear = pr.year; summaryMonth = pr.month;
        selectedDate = newEntries[0].date;
    }
    switchTab('tabCalendar');
}

// ============================================================
//  ★ AVISOS (notificaciones push)
//  El mismo día que haya extras pendientes, una Cloud Function (ver carpeta
//  /functions) manda un aviso a los dispositivos que activaron esto.
//  Cada dispositivo guarda su "token" en users/{uid}.fcmTokens.
// ============================================================
// Se saca de: Firebase Console → Configuración del proyecto → Cloud Messaging
// → "Certificados push web" → Generar par de claves → copiar la "Clave pública".
const VAPID_KEY = 'BGB_8In3RnI_oN2EbtgYwxOojy4fIcv7lc7ThXy6BEaDRmmcSFHAH3v8YkzUilEmk-bhy-k_i2TIdMbHF3oXMSQ';
const PUSH_TOKEN_KEY = 'horax_push_token_';

function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window &&
        !!(firebase.messaging && firebase.messaging.isSupported && firebase.messaging.isSupported());
}
function pushConfigured() { return !VAPID_KEY.startsWith('PEGAR'); }
function getSavedPushToken() {
    try { return currentUser ? localStorage.getItem(PUSH_TOKEN_KEY + currentUser.uid) : null; } catch (_) { return null; }
}
async function fetchPushToken() {
    const reg = await navigator.serviceWorker.ready;
    return firebase.messaging().getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
}
async function savePushToken(token) {
    await userDocRef(currentUser.uid).set(
        { fcmTokens: firebase.firestore.FieldValue.arrayUnion(token) }, { merge: true });
    try { localStorage.setItem(PUSH_TOKEN_KEY + currentUser.uid, token); } catch (_) {}
}

async function enablePush() {
    if (!currentUser) return;
    if (!pushSupported()) {
        showToast('Este navegador no soporta avisos. En iPhone, primero agregá la app a la pantalla de inicio.', 5000);
        return;
    }
    if (!pushConfigured()) { showToast('Falta pegar la clave VAPID en app.js'); return; }
    try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
            showToast('No diste permiso para los avisos. Podés activarlo desde los ajustes del navegador.', 4500);
            refreshPushUi();
            return;
        }
        const token = await fetchPushToken();
        if (!token) throw new Error('sin token');
        await savePushToken(token);
        showToast('Avisos activados en este dispositivo');
    } catch (err) {
        console.error('[HORAX] Error activando avisos:', err);
        showToast('No se pudieron activar los avisos');
    }
    refreshPushUi();
}

async function disablePush() {
    if (!currentUser) return;
    const token = getSavedPushToken();
    try {
        if (token) {
            await userDocRef(currentUser.uid).set(
                { fcmTokens: firebase.firestore.FieldValue.arrayRemove(token) }, { merge: true });
        }
        try { await firebase.messaging().deleteToken(); } catch (_) {}
        try { localStorage.removeItem(PUSH_TOKEN_KEY + currentUser.uid); } catch (_) {}
        showToast('Avisos desactivados en este dispositivo');
    } catch (err) {
        console.error('[HORAX] Error desactivando avisos:', err);
        showToast('No se pudieron desactivar los avisos');
    }
    refreshPushUi();
}

// Los tokens pueden cambiar con el tiempo: si ya estaban activados, se re-guardan solos.
async function syncPushToken() {
    try {
        if (!pushSupported() || !pushConfigured() || !currentUser) return;
        if (Notification.permission !== 'granted' || !getSavedPushToken()) return;
        const token = await fetchPushToken();
        if (token) await savePushToken(token);
    } catch (err) {
        console.warn('[HORAX] No se pudo actualizar el token de avisos:', err);
    }
}

function refreshPushUi() {
    const btn = document.getElementById('pushToggleBtn');
    const hint = document.getElementById('pushHint');
    if (!btn || !hint) return;
    const on = pushSupported() && pushConfigured() && Notification.permission === 'granted' && !!getSavedPushToken();
    btn.innerHTML = on
        ? '<i class="fas fa-bell-slash"></i> Desactivar avisos en este dispositivo'
        : '<i class="fas fa-bell"></i> Activar avisos de extras';
    btn.dataset.on = on ? '1' : '';
    if (!pushSupported()) {
        hint.textContent = 'Este navegador no permite avisos. En iPhone tenés que agregar la app a la pantalla de inicio primero.';
    } else if (Notification.permission === 'denied') {
        hint.textContent = 'Bloqueaste los avisos para este sitio. Activalos desde los ajustes del navegador.';
    } else {
        hint.textContent = on
            ? 'Este dispositivo recibe un aviso la mañana de cada día que haya extras pendientes.'
            : 'Te avisamos la mañana de cada día que haya extras pendientes, para que entres a marcarlas.';
    }
}

// Engancha el botón "Continuar con Google" de la tarjeta de login. Se llama
// una vez al arrancar la app y de nuevo cada vez que resetLoginCard() recrea
// el botón (porque quedó reemplazado por el formulario de alta automática).
function bindGoogleLoginButton() {
    const googleBtn = document.getElementById('googleLoginBtn');
    if (!googleBtn) return;
    googleBtn.addEventListener('click', () => {
        const errorEl = document.getElementById('loginError');
        if (errorEl) errorEl.style.display = 'none';
        const provider = new firebase.auth.GoogleAuthProvider();
        // Siempre mostrar el selector de cuentas de Google (si no, entra directo con el último mail usado)
        provider.setCustomParameters({ prompt: 'select_account' });
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
}

function init() {
    const today = hoyDate();
    currentMonth = today.getMonth();
    currentYear = today.getFullYear();
    const cyc = currentCyclePeriod();
    summaryYear = cyc.year; summaryMonth = cyc.month;
    selectedDate = formatDate(today);
    const addDate = document.getElementById('addDate');
    if (addDate) addDate.value = formatDate(today);

    bindGoogleLoginButton();
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', async () => {
        const ok = await showConfirm({
            title: '¿Cerrar sesión?',
            message: 'Vas a tener que volver a iniciar sesión con Google la próxima vez que abras HORAX.',
            okText: 'Cerrar sesión',
            cancelText: 'Cancelar'
        });
        if (ok) auth.signOut();
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
    document.getElementById('pushToggleBtn').addEventListener('click', () => {
        if (document.getElementById('pushToggleBtn').dataset.on === '1') disablePush(); else enablePush();
    });
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
        selectedDate = null; renderCalendar();
    });
    document.getElementById('nextMonth').addEventListener('click', () => {
        currentMonth++; if (currentMonth > 11) { currentMonth = 0; currentYear++; }
        selectedDate = null; renderCalendar();
    });
    document.addEventListener('click', ev => {
        const bar = ev.target.closest && ev.target.closest('.today-bar');
        if (!bar) return;
        if (bar.dataset.scope === 'summary') goToCurrentPeriod(); else goToToday();
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
        const commentEl = document.getElementById('addComment');
        const comment = commentEl ? commentEl.value.trim() : '';
        if (!date || !start || !end || !person) { showToast('Completá todos los campos'); return; }
        if (start >= end) { showToast('El inicio debe ser anterior al final'); return; }
        addEntry(date, start, end, person, comment);
        document.getElementById('addPerson').value = '';
        if (commentEl) commentEl.value = '';
        selectedDate = date;
        switchTab('tabCalendar');
    });
        // El tacho del header ahora borra SOLO el mes del calendario
    document.getElementById('clearBtn').addEventListener('click', clearMonth);
    // El botón de Admin sí borra todo (queda como válvula de escape)
    const clearAllBtn = document.getElementById('clearAllBtn');
    if (clearAllBtn) clearAllBtn.addEventListener('click', clearAllData);

    document.getElementById('viewAuditBtn').addEventListener('click', openAuditModal);
    document.getElementById('auditCloseBtn').addEventListener('click', closeAuditModal);
    document.getElementById('auditModal').addEventListener('click', ev => {
        if (ev.target.id === 'auditModal') closeAuditModal();
    });

    // ★ NUEVO (#5): botones para exportar el resumen (CSV / PDF)
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportSummaryCsv);
    const exportPdfBtn = document.getElementById('exportPdfBtn');
    if (exportPdfBtn) exportPdfBtn.addEventListener('click', exportSummaryPdf);

    // Buscador y filtro "Ocultar ya hechas" del Resumen (se filtra en vivo)
    const summarySearch = document.getElementById('summarySearch');
    if (summarySearch) {
        summarySearch.value = summaryFilter;
        summarySearch.addEventListener('input', () => {
            summaryFilter = summarySearch.value;
            renderSummary();
        });
    }
    const hideDoneToggle = document.getElementById('hideDoneToggle');
    if (hideDoneToggle) {
        hideDoneToggle.classList.toggle('active', hideDone);
        hideDoneToggle.setAttribute('aria-pressed', String(hideDone));
        hideDoneToggle.addEventListener('click', () => {
            hideDone = !hideDone;
            hideDoneToggle.classList.toggle('active', hideDone);
            hideDoneToggle.setAttribute('aria-pressed', String(hideDone));
            renderSummary();
        });
    }

    document.getElementById('editUserRole').addEventListener('change', updateEditUserLocalVisibility);
    document.getElementById('editUserSaveBtn').addEventListener('click', saveEditUserFromModal);
    document.getElementById('editUserCancelBtn').addEventListener('click', closeEditUserModal);

    // Admin: crear locales
    const newLocalBtn = document.getElementById('newLocalBtn');
    if (newLocalBtn) newLocalBtn.addEventListener('click', openNewLocalModal);
    const newLocalCancelBtn = document.getElementById('newLocalCancelBtn');
    if (newLocalCancelBtn) newLocalCancelBtn.addEventListener('click', closeNewLocalModal);
    const newLocalSaveBtn = document.getElementById('newLocalSaveBtn');
    if (newLocalSaveBtn) newLocalSaveBtn.addEventListener('click', saveNewLocalFromModal);
    const newLocalName = document.getElementById('newLocalName');
    if (newLocalName) newLocalName.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); saveNewLocalFromModal(); }
        else if (ev.key === 'Escape') closeNewLocalModal();
    });
    const newLocalModal = document.getElementById('newLocalModal');
    if (newLocalModal) newLocalModal.addEventListener('click', ev => {
        if (ev.target.id === 'newLocalModal') closeNewLocalModal();
    });
    document.getElementById('editUserModal').addEventListener('click', ev => {
        if (ev.target.id === 'editUserModal') closeEditUserModal();
    });

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

        // Tutorial de instalación PWA (banner + modal + botón en el perfil)
    initInstallPrompt();

    console.log('✅ HORAX iniciada');
}
// ============================================================
//  TUTORIAL DE INSTALACIÓN (PWA) — un paso por pantalla, con dibujo del celu
//  Verificado: iOS 26 (⋯ → Compartir → Agregar a pantalla de inicio),
//  iOS 18 o anterior (botón Compartir abajo), Chrome Android, Chrome/Edge/Safari de compu.
//  En Android y Chrome/Edge de compu aparece "Instalar ahora" si el navegador lo permite.
// ============================================================
const INSTALL_DISMISSED_KEY = 'horax_install_dismissed_v1';
let deferredInstallPrompt = null, installOS = null, installIOSVer = '26', installIdx = 0;

window.addEventListener('beforeinstallprompt', ev => { ev.preventDefault(); deferredInstallPrompt = ev; refreshInstallUI(); });
window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null; markInstallDismissed(); hideInstallBanner(); closeInstallModal();
    if (typeof showToast === 'function') showToast('¡HORAX instalada! Abrila desde el ícono ✨', 4500);
});

function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true ||
        (document.referrer && document.referrer.startsWith('android-app://'));
}
function detectPlatform() {
    const ua = navigator.userAgent || '';
    if ((/iPad|iPhone|iPod/.test(ua) && !window.MSStream) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    return /Android/.test(ua) ? 'android' : 'desktop';
}
function installDismissed() { try { return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1'; } catch (_) { return false; } }
function markInstallDismissed() { try { localStorage.setItem(INSTALL_DISMISSED_KEY, '1'); } catch (_) {} }

// ---- Íconos (SVG, no dependen de Font Awesome) ----
const IC = {
    share: '<path d="M12 14V3m0 0L8 7m4-4 4 4M8 10H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1"/>',
    dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    dotsV: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
    plus: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
    down: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/>',
    tabs: '<rect x="4" y="7" width="13" height="13" rx="2"/><path d="M8 4h11a1 1 0 0 1 1 1v11"/>',
    back: '<path d="m15 5-7 7 7 7"/>', fwd: '<path d="m9 5 7 7-7 7"/>'
};
const ic = n => `<svg class="sc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[n]}</svg>`;

// ---- Piezas para dibujar las pantallas ----
const hl = (h, html) => h ? `<span class="hl-wrap">${html}</span>` : html;
const scBrand = name => `<div class="sc-brand">${name}</div>`;
const scBar = (icon, name, side) => `<div class="sc-bar${side === 'left' ? ' rev' : ''}"><span class="sc-url">🔒 ${location.hostname || 'horax'}</span>${hl(true, `<span class="sc-btn">${ic(icon)}</span>`)}</div>`;
const scTabbar = () => `<div class="sc-tabbar"><span class="sc-btn dim">${ic('back')}</span><span class="sc-btn dim">${ic('fwd')}</span>${hl(true, `<span class="sc-btn">${ic('share')}</span>`)}<span class="sc-btn dim">${ic('book')}</span><span class="sc-btn dim">${ic('tabs')}</span></div>`;
const skel = w => `<div class="sc-row skel"><span style="width:${w}%"></span></div>`;
const scList = rows => `<div class="sc-list">${rows.join('')}</div>`;
const scRow = (icon, label, h) => `<div class="sc-row${h ? ' hl' : ''}"><span>${label}</span>${ic(icon)}</div>`;
const scDialog = (switchOn, btn, btnTop) => `<div class="sc-dialog">
    <div class="sc-dhead"><span>Cancelar</span><b>Agregar a inicio</b><span class="sc-primary hl">${btn}</span></div>
    <div class="sc-field"><span class="sc-appicon">H</span><span>HORAX</span></div>
    ${switchOn ? `<div class="sc-row"><span>Abrir como app web</span><span class="sc-switch"></span></div>` : ''}</div>`;
const scAppIcon = () => `<div class="sc-home"><span class="sc-appicon big">H</span><span>HORAX</span></div>`;
const scInstallDlg = () => `<div class="sc-dialog"><div class="sc-field"><span class="sc-appicon">H</span><span>Instalar HORAX</span></div><div class="sc-dfoot"><span>Cancelar</span><span class="sc-primary hl">Instalar</span></div></div>`;

const IOS_SHARE_SHEET = () => scList([skel(60), skel(75), scRow('plus', 'Agregar a pantalla de inicio', true), skel(50)]);
const IOS_TAIL = [
    { t: 'Deslizá la lista hacia arriba hasta ver <b>Agregar a pantalla de inicio</b> y tocala.<br><small>No la confundas con "Agregar marcador".</small>', s: IOS_SHARE_SHEET },
    { t: 'Dejá activado <b>Abrir como app web</b> y tocá <b>Agregar</b>, arriba a la derecha.<br><small>Si no ves ese interruptor, no pasa nada.</small>', s: () => scDialog(true, 'Agregar') },
    { t: '¡Listo! Ahora abrí HORAX desde el <b>ícono nuevo</b> de tu pantalla de inicio, no desde Safari.', s: scAppIcon, done: true }
];
const INSTALL_IMG = './img/install/';
// Captura real con círculos resaltados. hl = [[izq%, arriba%, ancho%, alto%, radio?], ...] sobre la imagen
const shot = (file, hls) => `<div class="shot"><img src="${INSTALL_IMG}${file}" alt="" draggable="false">${(hls || []).map(h => `<span class="shot-hl" style="left:${h[0]}%;top:${h[1]}%;width:${h[2]}%;height:${h[3]}%;border-radius:${h[4] || '14px'}"></span>`).join('')}</div><div class="shot-hint">Tocá la imagen para agrandarla</div>`;
function zoomShot(el) {
    const o = document.createElement('div'); o.className = 'shot-zoom'; o.innerHTML = el.outerHTML;
    o.addEventListener('click', () => o.remove()); document.body.appendChild(o);
}
const INSTALL_HEAD = {
    ios: { banner: 'Instalá HORAX en tu iPhone', sub: 'Desde Safari, en menos de un minuto. Así también te llegan los avisos.', modal: 'Instalá HORAX en tu iPhone (Safari)' },
    android: { banner: 'Instalá HORAX en tu Android', sub: 'Un toque y queda en tu pantalla de inicio.', modal: 'Instalá HORAX en tu Android (Chrome)' },
    desktop: { banner: 'Instalá HORAX en tu compu', sub: 'Se abre en su propia ventana, sin buscarla en el navegador.', modal: 'Instalá HORAX en tu compu (Chrome o Edge)' }
};
function applyInstallHeadlines() {
    const hb = INSTALL_HEAD[detectPlatform()], hm = INSTALL_HEAD[installOS];
    const b = document.querySelector('#installBanner strong'), bs = document.querySelector('#installBanner small');
    if (b && hb) b.textContent = hb.banner; if (bs && hb) bs.textContent = hb.sub;
    const h2 = document.querySelector('#installModal h2');
    if (h2 && hm && h2.lastChild) h2.lastChild.textContent = hm.modal;
}
const INSTALL_STEPS = {
    ios26: [
        { h: 'Abrí HORAX en Safari', t: '<small>Si llegaste desde WhatsApp, tocá <b>Abrir en Safari</b>.</small>', s: () => scBrand('Safari'),
          p: () => '<img class="sc-safari" src="' + INSTALL_IMG + 'safari.png" alt="Safari">' },
        { h: 'Tocá los tres puntitos', t: 'Están a la derecha de la barra de direcciones.', s: () => scBar('dots'),
          p: () => shot('ios-barra.jpg', [[79.1, 17.7, 12.2, 48.2, '50%']]) },
        { h: 'Tocá Compartir', t: 'Es la primera opción del menú.', s: () => scList([skel(55), scRow('share', 'Compartir', true), skel(70)]),
          p: () => shot('ios-menu.jpg', [[6.5, 4.5, 88.3, 10.6]]) },
        { h: 'Tocá Agregar a Inicio', t: '<small>No la confundas con "Agregar marcador a…". Si no la ves, tocá <b>Ver más</b> o deslizá la lista hacia arriba.</small>', s: IOS_SHARE_SHEET,
          p: () => shot('ios-compartir.jpg', [[5.1, 87.5, 89.9, 9.6]]) },
        { h: 'Tocá Agregar', t: 'Dejá activado <b>Abrir como app web</b> y tocá <b>Agregar</b>, arriba a la derecha.<small>Si no ves ese interruptor, no pasa nada.</small>', s: () => scDialog(true, 'Agregar'),
          p: () => shot('ios-agregar.jpg', [[71.7, 8.0, 24.2, 13.1, '999px'], [79.9, 74.5, 15.9, 8.5, '999px']]) },
        { h: '¡Listo!', t: 'Abrí HORAX desde el <b>ícono nuevo</b> de tu pantalla de inicio, no desde Safari.', s: scAppIcon, done: true,
          p: () => '<div class="sc-home"><img class="sc-homeimg" src="./icons/icon-192.png" alt="HORAX"><span>HORAX</span></div>' }
    ],
    ios18: [
        { t: 'Abrí HORAX en <b>Safari</b>.<br><small>Si llegaste desde WhatsApp, tocá <b>Abrir en Safari</b>.</small>', s: () => scBrand('Safari') },
        { t: 'Tocá el botón <b>Compartir</b> (un cuadradito con una flecha hacia arriba), abajo en el centro.', s: scTabbar },
        ...IOS_TAIL
    ],
    android: [
        { t: 'Abrí HORAX en <b>Chrome</b>.', s: () => scBrand('Chrome') },
        { t: 'Tocá los <b>tres puntitos</b> arriba a la derecha.', s: () => scBar('dotsV') },
        { t: 'Tocá <b>Instalar app</b> (o <b>Agregar a la pantalla principal</b>).<br><small>Si te deja elegir, tocá <b>Instalar</b>, no "acceso directo".</small>', s: () => scList([skel(60), scRow('down', 'Instalar app', true), skel(70)]) },
        { t: 'Confirmá tocando <b>Instalar</b>.', s: scInstallDlg },
        { t: '¡Listo! HORAX queda en tu pantalla de inicio, como cualquier app.', s: scAppIcon, done: true }
    ],
    desktop: [
        { t: 'Abrí HORAX en <b>Chrome</b> o <b>Edge</b>.', s: () => scBrand('Chrome · Edge') },
        { t: 'A la derecha de la barra de direcciones, hacé clic en el <b>ícono de instalar</b>.<br><small>Si no aparece: menú ⋮ → <b>Guardar y compartir</b> → <b>Instalar página como app</b>. En Edge: menú ⋯ → <b>Aplicaciones</b> → <b>Instalar este sitio como aplicación</b>.</small>', s: () => scBar('down') },
        { t: 'Confirmá con <b>Instalar</b>.', s: scInstallDlg },
        { t: '¡Listo! Se abre en su propia ventana, como cualquier programa.', s: scAppIcon, done: true }
    ]
};
const INSTALL_NOTES = {
    ios: '<b>Avisos:</b> solo llegan si abrís la app desde el ícono nuevo (necesita iOS 16.4 o más nuevo). Si tu iPhone es de los últimos, usá la opción "iOS 26".',
    android: '¿Samsung Internet? Menú ☰ → <b>Agregar página a</b> → <b>Pantalla de inicio</b>. ¿Firefox? Menú ⋮ → <b>Instalar</b>.',
    desktop: '<b>Safari en Mac:</b> menú Archivo → <b>Agregar al Dock</b>. Firefox en compu no permite instalar apps.'
};

function currentInstallKey() { return installOS === 'ios' ? 'ios' + installIOSVer : installOS; }

function renderInstall() {
    const steps = INSTALL_STEPS[currentInstallKey()], st = steps[installIdx];
    const stage = document.getElementById('installStage');
    stage.innerHTML = st.p ? st.p() : st.s();
    // si una imagen no carga (sin internet, archivo faltante), se muestra el dibujo de respaldo
    stage.querySelectorAll('img').forEach(im => im.addEventListener('error', () => { stage.innerHTML = st.s(); }, { once: true }));
    const sh = stage.querySelector('.shot'); if (sh) sh.addEventListener('click', () => zoomShot(sh));
    document.getElementById('installText').innerHTML = (st.h ? `<strong class="install-h">${st.h}</strong>` : '') + st.t;
    document.getElementById('installDots').innerHTML = steps.map((_, i) => `<i class="${i === installIdx ? 'on' : (i < installIdx ? 'past' : '')}"></i>`).join('');
    const prev = document.getElementById('installPrev'), next = document.getElementById('installNext');
    prev.style.visibility = installIdx === 0 ? 'hidden' : 'visible';
    next.textContent = installIdx === steps.length - 1 ? 'Cerrar' : 'Siguiente';
    document.getElementById('installCounter').textContent = `Paso ${installIdx + 1} de ${steps.length}`;
}

function setInstallOS(os) {
    installOS = os; installIdx = 0;
    document.querySelectorAll('#installTabs .install-tab').forEach(t => t.classList.toggle('active', t.dataset.os === os));
    const sub = document.getElementById('installSub');
    sub.style.display = os === 'ios' ? 'flex' : 'none';
    sub.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.ver === installIOSVer));
    document.getElementById('installNote').innerHTML = INSTALL_NOTES[os] || '';
    const ua = navigator.userAgent || '', here = detectPlatform() === os, warn = document.getElementById('installWarn');
    let w = '';
    if (here && /FBAN|FBAV|Instagram|TikTok|Snapchat|Line\/|Twitter|GSA\//.test(ua)) w = 'Estás dentro de otra app. Abrí este link en <b>' + (os === 'ios' ? 'Safari' : 'Chrome') + '</b> para poder instalarla.';
    else if (here && os === 'ios' && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) w = 'Este no es Safari. Para que se instale bien y lleguen los avisos, abrí el link en <b>Safari</b>.';
    warn.innerHTML = w; warn.style.display = w ? 'block' : 'none';
    renderInstall(); refreshInstallUI(); applyInstallHeadlines();
}

function refreshInstallUI() {
    const nowBtn = document.getElementById('installNowBtn');
    if (nowBtn) nowBtn.style.display = (deferredInstallPrompt && installOS === detectPlatform() && installOS !== 'ios') ? 'flex' : 'none';
    const b = document.getElementById('installBannerBtn');
    if (b) b.textContent = deferredInstallPrompt ? 'Instalar' : 'Ver cómo';
}
async function triggerNativeInstall() {
    const ev = deferredInstallPrompt; if (!ev) return;
    deferredInstallPrompt = null;
    try { ev.prompt(); const c = await ev.userChoice; if (c && c.outcome === 'accepted') { markInstallDismissed(); hideInstallBanner(); } }
    catch (err) { console.warn('[HORAX] Instalador nativo no disponible:', err); }
    refreshInstallUI();
}

function openInstallModal() {
    const modal = document.getElementById('installModal'); if (!modal) return;
    setInstallOS(detectPlatform());
    const s = document.getElementById('installStatus');
    s.style.display = isStandalone() ? 'block' : 'none';
    if (isStandalone()) s.textContent = '✅ Ya estás usando HORAX como app. Esto sirve para instalarla en otro dispositivo.';
    modal.style.display = 'flex';
}
function closeInstallModal() { const m = document.getElementById('installModal'); if (m) m.style.display = 'none'; }
function showInstallBanner() { const b = document.getElementById('installBanner'); if (b) { refreshInstallUI(); applyInstallHeadlines(); b.style.display = 'flex'; } }
function hideInstallBanner() { const b = document.getElementById('installBanner'); if (b) b.style.display = 'none'; }

// Se llama desde handleSignedIn() cada vez que hay usuario + local
function maybeShowInstallBanner() {
    if (isStandalone()) { markInstallDismissed(); return; }
    if (installDismissed() || !currentUser || !currentLocalId) return;
    setTimeout(() => { if (!installDismissed() && currentUser && currentLocalId) showInstallBanner(); }, 1200);
}

function initInstallPrompt() {
    const $ = id => document.getElementById(id);
    if ($('installBannerBtn')) $('installBannerBtn').addEventListener('click', () => { hideInstallBanner(); if (deferredInstallPrompt) triggerNativeInstall(); else openInstallModal(); });
    if ($('installBannerClose')) $('installBannerClose').addEventListener('click', () => { hideInstallBanner(); markInstallDismissed(); });
    if ($('installCloseBtn')) $('installCloseBtn').addEventListener('click', closeInstallModal);
    if ($('installNowBtn')) $('installNowBtn').addEventListener('click', triggerNativeInstall);
    if ($('installModal')) $('installModal').addEventListener('click', ev => { if (ev.target.id === 'installModal') closeInstallModal(); });
    document.querySelectorAll('#installTabs .install-tab').forEach(t => t.addEventListener('click', () => setInstallOS(t.dataset.os)));
    document.querySelectorAll('#installSub button').forEach(b => b.addEventListener('click', () => { installIOSVer = b.dataset.ver; setInstallOS('ios'); }));
    if ($('installPrev')) $('installPrev').addEventListener('click', () => { if (installIdx > 0) { installIdx--; renderInstall(); } });
    if ($('installNext')) $('installNext').addEventListener('click', () => {
        const n = INSTALL_STEPS[currentInstallKey()].length;
        if (installIdx < n - 1) { installIdx++; renderInstall(); } else closeInstallModal();
    });

    const profileModal = $('profileModal');
    if (profileModal && !$('openInstallHelpBtn')) {
        const pushGroup = $('pushGroup');
        if (pushGroup && pushGroup.parentNode) {
            const g = document.createElement('div');
            g.className = 'form-group';
            g.innerHTML = `<label>Instalar en el celu</label>
                <button type="button" class="btn-secondary" id="openInstallHelpBtn" style="width:100%;"><i class="fas fa-mobile-screen-button"></i> ¿Cómo instalar HORAX?</button>`;
            pushGroup.parentNode.insertBefore(g, pushGroup);
            $('openInstallHelpBtn').addEventListener('click', openInstallModal);
        }
    }
}

// Arranque de la app (el script se carga con defer, pero por las dudas se cubre ambos casos)
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();