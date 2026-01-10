/* =====================================================
   ГОРОДСКОЙ СИМУЛЯТОР — JavaScript
   Платформа партиципаторного проектирования
   ===================================================== */

// =====================================================
// FIREBASE КОНФИГУРАЦИЯ
// =====================================================

// ✅ Firebase подключен!
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBA74HiLorOH_KElzzABBNo9lQe4-1wrhA",
    authDomain: "citysimulation-7e41c.firebaseapp.com",
    databaseURL: "https://citysimulation-7e41c-default-rtdb.firebaseio.com",
    projectId: "citysimulation-7e41c",
    storageBucket: "citysimulation-7e41c.firebasestorage.app",
    messagingSenderId: "806775444874",
    appId: "1:806775444874:web:43f22e22608bd4a3c16473"
};

// Инициализация Firebase (если конфигурация заполнена)
let firebaseApp = null;
let firebaseDB = null;
let firebaseEnabled = false;

// =====================================================
// ЛОКАЛЬНАЯ СИНХРОНИЗАЦИЯ (fallback без Firebase)
// Работает между вкладками на одном компьютере.
// =====================================================

const LOCAL_SYNC = {
    channelName: 'citysim-sync-v1',
    storagePrefix: 'citysim:v1:',
    clientId: Math.random().toString(36).slice(2) + Date.now().toString(36),
    channel: null,
    enabled: true
};

// =====================================================
// МОДЕРАЦИЯ/СООБЩЕНИЯ (broadcast)
// =====================================================

function showBroadcast(message, meta = {}) {
    if (!message) return;
    
    // Баннер на экране участника
    const banner = $('#broadcast-banner');
    const textEl = $('#broadcast-text');
    if (banner && textEl) {
        textEl.textContent = message;
        banner.classList.remove('hidden');
        // Автоскрытие
        setTimeout(() => banner.classList.add('hidden'), 9000);
    }
    
    showNotification(`Сообщение модератора: ${message}`, 'info');
    addToLog('broadcast', `Сообщение модератора: ${message}`);
}

function sendBroadcastMessage(message) {
    if (!message || !state.session.code) return;
    
    const payload = {
        message,
        from: state.user.name || (state.user.isModerator ? 'Модератор' : 'Участник'),
        time: new Date().toISOString()
    };
    
    // Локальный режим: рассылаем между вкладками
    if (!firebaseEnabled) {
        localBroadcast({ type: 'broadcast', code: state.session.code, payload });
        showBroadcast(message, payload);
        return;
    }
    
    // Firebase: пишем в sessions/{code}/broadcasts
    try {
        const ref = firebaseDB.ref(`sessions/${state.session.code}/broadcasts`).push();
        ref.set(payload).catch((e) => {
            console.error('❌ Ошибка отправки сообщения модератора:', e);
            showNotification('Не удалось отправить сообщение', 'error');
        });
    } catch (e) {
        console.error('❌ Ошибка отправки сообщения модератора:', e);
        showNotification('Не удалось отправить сообщение', 'error');
    }
}

function localSessionKey(code) {
    return `${LOCAL_SYNC.storagePrefix}sessions:${code}`;
}

function localReadSession(code) {
    try {
        const raw = localStorage.getItem(localSessionKey(code));
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.error('❌ LocalSync: ошибка чтения localStorage:', e);
        return null;
    }
}

function localWriteSession(code, data) {
    try {
        localStorage.setItem(localSessionKey(code), JSON.stringify(data));
        return true;
    } catch (e) {
        console.error('❌ LocalSync: ошибка записи localStorage:', e);
        return false;
    }
}

function localBroadcast(message) {
    if (!LOCAL_SYNC.enabled) return;
    const payload = { ...message, _from: LOCAL_SYNC.clientId, _ts: Date.now() };
    try {
        if (LOCAL_SYNC.channel) {
            LOCAL_SYNC.channel.postMessage(payload);
        } else {
            // Fallback: storage-event
            localStorage.setItem(`${LOCAL_SYNC.storagePrefix}broadcast`, JSON.stringify(payload));
        }
    } catch (e) {
        console.warn('⚠️ LocalSync: не удалось отправить сообщение:', e);
    }
}

function initLocalSync() {
    if (!LOCAL_SYNC.enabled) return;
    try {
        if ('BroadcastChannel' in window) {
            LOCAL_SYNC.channel = new BroadcastChannel(LOCAL_SYNC.channelName);
            LOCAL_SYNC.channel.onmessage = (ev) => {
                const msg = ev?.data;
                if (!msg || msg._from === LOCAL_SYNC.clientId) return;
                handleLocalMessage(msg);
            };
        } else {
            window.addEventListener('storage', (e) => {
                if (e.key !== `${LOCAL_SYNC.storagePrefix}broadcast` || !e.newValue) return;
                try {
                    const msg = JSON.parse(e.newValue);
                    if (!msg || msg._from === LOCAL_SYNC.clientId) return;
                    handleLocalMessage(msg);
                } catch (_) {}
            });
        }
    } catch (e) {
        console.warn('⚠️ LocalSync: недоступна локальная синхронизация:', e);
        LOCAL_SYNC.enabled = false;
    }
}

function handleLocalMessage(msg) {
    if (!msg || msg.code !== state.session.code) return;
    switch (msg.type) {
        case 'session_update':
            syncSessionFromLocal(msg.data);
            break;
        case 'phase_update':
            if (typeof msg.phase === 'number') {
                // Имитируем Firebase listener фазы
                if (msg.phase !== state.session.phase) {
                    const oldPhase = state.session.phase;
                    state.session.phase = msg.phase;
                    console.log(`🔄 LocalSync: смена фазы ${oldPhase} → ${msg.phase}`);
                    updatePhaseUI();
                    if (!state.user.isModerator) {
                        updateEventBanner(msg.phase);
                        renderParameters();
                        updateConfirmButton();
                    }
                }
            }
            break;
        case 'participants_child_added':
            if (msg.participant && !state.participants.find(p => p.id === msg.participant.id)) {
                const participant = normalizeParticipant(msg.participant);
                state.participants.push(participant);
                const teamId = getParticipantTeamId(participant);
                if (teamId) initTeamData(teamId);
                // Новые участники меняют состав команды → пересчёт агрегации
                try { recomputeAllTeamAggregates(); } catch (_) {}
                if (state.user.isModerator) {
                    renderParticipantsList();
                    renderParamsMatrix();
                    updateMetrics();
                } else {
                    renderTeamMembersList();
                    renderParameters();
                    updateConfirmButton();
                    updateIGSDisplay();
                }
            }
            break;
        case 'teams_update':
            if (msg.teams) {
                Object.keys(msg.teams).forEach(teamId => {
                    state.teamsData[teamId] = msg.teams[teamId];
                });
                // Если есть решения участников — агрегация переопределит teamData.parameters/confirmed
                try { recomputeAllTeamAggregates(); } catch (_) {}
                if (state.user.isModerator) {
                    renderParticipantsList();
                    renderParamsMatrix();
                    renderAvgParams();
                    updateMetrics();
                    updateCharts();
                } else {
                    updateIGSDisplay();
                }
            }
            break;
        case 'decisions_update':
            if (msg.decisions) {
                state.participantDecisions = normalizeDecisionsMap(msg.decisions);
                try { recomputeAllTeamAggregates(); } catch (_) {}
                if (state.user.isModerator) {
                    updateModeratorUI();
                } else {
                    renderTeamMembersList();
                    renderParameters();
                    updateConfirmButton();
                    updateIGSDisplay();
                }
            }
            break;
        case 'broadcast':
            if (msg.payload?.message) {
                showBroadcast(msg.payload.message, msg.payload);
            }
            break;
        case 'event':
            if (!state.user.isModerator && msg.event?.effect) {
                applyEventEffect(msg.event);
                renderParameters();
                updateConfirmButton();
                showNotification(`Событие: ${msg.event.name || 'изменение условий'}`, 'warning');
            }
            break;
    }
}

function syncSessionFromLocal(data) {
    if (!data) return;
    // Данные в localStorage храним как { session, phase, participants, teams, decisions }
    if (data.session) {
        // createdAt может быть строкой
        const createdAt = data.session.createdAt ? new Date(data.session.createdAt) : state.session.createdAt;
        // Игнорируем data.session.phase: фазу храним отдельным полем data.phase
        const { phase, ...rest } = data.session;
        state.session = { ...state.session, ...rest, createdAt };
        if (typeof data.phase === 'number') state.session.phase = data.phase;
    }
    if (data.participants) {
        state.participants = Object.values(data.participants).map(normalizeParticipant);
        // Инициализация teamData для всех команд
        state.participants.forEach(p => {
            const teamId = getParticipantTeamId(p);
            if (teamId) initTeamData(teamId);
        });
    }
    if (data.teams) {
        state.teamsData = { ...state.teamsData, ...data.teams };
    }
    if (data.decisions) {
        state.participantDecisions = normalizeDecisionsMap(data.decisions);
        try { recomputeAllTeamAggregates(); } catch (_) {}
    }
    updatePhaseUI();
}

function initFirebase() {
    if (FIREBASE_CONFIG.apiKey === "YOUR_API_KEY") {
        console.warn('⚠️ Firebase не настроен. Работаем в локальном режиме.');
        return false;
    }
    
    try {
        firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
        firebaseDB = firebase.database();
        firebaseEnabled = true;
        console.log('✅ Firebase подключен');
        
        // Диагностика соединения (Realtime Database)
        try {
            firebaseDB.ref('.info/connected').on('value', (snap) => {
                const connected = !!snap.val();
                console.log('🌐 Firebase connected:', connected);
                if (!connected) {
                    // Не спамим — показываем мягкое предупреждение
                    showNotification('Нет соединения с Firebase. Проверьте интернет или доступ к сервису.', 'warning');
                }
            });
        } catch (e) {
            console.warn('⚠️ Не удалось подписаться на .info/connected:', e);
        }
        
        return true;
    } catch (error) {
        console.error('❌ Ошибка Firebase:', error);
        return false;
    }
}

function withTimeout(promise, ms, timeoutMessage = 'Таймаут операции') {
    let t = null;
    const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (t) clearTimeout(t);
    });
}

// =====================================================
// FIREBASE СИНХРОНИЗАЦИЯ
// =====================================================

// Подписка на изменения сессии
function subscribeToSession(sessionCode) {
    // Fallback: локальная синхронизация между вкладками
    if (!firebaseEnabled) {
        initLocalSync();
        const data = localReadSession(sessionCode);
        if (data) {
            syncSessionFromLocal(data);
        }
        console.log(`📡 LocalSync: подписка на сессию ${sessionCode}`);
        return;
    }
    
    const sessionRef = firebaseDB.ref(`sessions/${sessionCode}`);
    
    // Слушаем изменения метаданных сессии (БЕЗ фазы!)
    // Фаза — единственный источник правды: sessions/{code}/phase
    sessionRef.child('session').on('value', (snapshot) => {
        const sessionData = snapshot.val();
        if (sessionData) {
            syncSessionDataFromFirebase(sessionData);
        }
    });
    
    // Загружаем всех существующих участников (для модератора)
    if (state.user.isModerator) {
        console.log('🔍 Модератор: загружаю существующих участников...');
        sessionRef.child('participants').once('value', (snapshot) => {
            const participants = snapshot.val();
            console.log('📦 Firebase вернул участников:', participants);
            
            if (participants) {
                console.log('👥 Загружаю существующих участников:', Object.keys(participants).length);
                
                // Очищаем список и загружаем заново
                state.participants = [];
                Object.keys(participants).forEach(participantId => {
                    const participant = normalizeParticipant(participants[participantId]);
                    console.log('  ➕ Добавляю участника:', participant.name);
                    if (!state.participants.find(p => p.id === participant.id)) {
                        state.participants.push(participant);
                        
                        // Инициализируем данные команды если нужно
                        const teamId = getParticipantTeamId(participant);
                        if (teamId) initTeamData(teamId);
                    }
                });
                
                console.log('✅ Загружено участников:', state.participants.length);
                try { recomputeAllTeamAggregates(); } catch (_) {}
                renderParticipantsList();
                renderParamsMatrix();
                updateMetrics();
            } else {
                console.log('⚠️ Нет существующих участников в Firebase');
            }
        });
    }
    
    // Слушаем добавление новых участников
    sessionRef.child('participants').on('child_added', (snapshot) => {
        const participant = normalizeParticipant(snapshot.val());
        console.log('🔔 child_added сработал! Участник:', participant?.name, 'Модератор?', state.user.isModerator);
        
        if (participant && !state.participants.find(p => p.id === participant.id)) {
            console.log('➕ Новый участник:', participant.name, 'Команда:', participant.team?.name);
            state.participants.push(participant);
            
            // Инициализируем данные команды если нужно
            const teamId = getParticipantTeamId(participant);
            if (teamId) initTeamData(teamId);
            try { recomputeAllTeamAggregates(); } catch (_) {}
            
            if (state.user.isModerator) {
                console.log('🔄 Обновляю UI модератора...');
                renderParticipantsList();
                renderParamsMatrix();
                updateMetrics();
                console.log('✅ UI модератора обновлён. Всего участников:', state.participants.length);
            } else {
                renderTeamMembersList();
                renderParameters();
                updateConfirmButton();
                updateIGSDisplay();
            }
        } else if (participant && state.participants.find(p => p.id === participant.id)) {
            console.log('⚠️ Участник уже есть в списке:', participant.name);
        }
    });
    
    // Слушаем изменения команд
    sessionRef.child('teams').on('value', (snapshot) => {
        const teamsData = snapshot.val();
        if (teamsData) {
            console.log('📦 Firebase: получены данные команд:', Object.keys(teamsData));
            
            Object.keys(teamsData).forEach(teamId => {
                const oldConfirmed = state.teamsData[teamId]?.confirmed;
                const newConfirmed = teamsData[teamId].confirmed;
                
                state.teamsData[teamId] = teamsData[teamId];
                
                // Логируем изменение статуса подтверждения
                if (oldConfirmed !== newConfirmed) {
                    console.log(`🔄 Команда ${teamId}: confirmed ${oldConfirmed} → ${newConfirmed}`);
                }
            });

            // Если ведём решения по участникам — пересчитываем агрегацию и переопределяем параметры/confirmed
            try { recomputeAllTeamAggregates(); } catch (_) {}
            
            if (state.user.isModerator) {
                renderParticipantsList();
                renderParamsMatrix();
                renderAvgParams();
                updateMetrics();
                updateCharts();
            } else {
                updateIGSDisplay();
            }
        }
    });

    // Слушаем решения участников (новая модель) и агрегируем по командам
    sessionRef.child('decisions').on('value', (snapshot) => {
        const decisions = snapshot.val();
        state.participantDecisions = normalizeDecisionsMap(decisions);
        try { recomputeAllTeamAggregates(); } catch (_) {}

        if (state.user.isModerator) {
            updateModeratorUI();
        } else {
            renderTeamMembersList();
            renderParameters();
            updateConfirmButton();
            updateIGSDisplay();
        }
    });
    
    // Слушаем изменения фазы
    sessionRef.child('phase').on('value', (snapshot) => {
        const raw = snapshot.val();
        const phase = raw === null ? null : Number(raw);
        console.log('📍 Firebase: получена фаза', phase, 'текущая:', state.session.phase);
        if (phase !== null && !Number.isNaN(phase) && phase !== state.session.phase) {
            const oldPhase = state.session.phase;
            state.session.phase = phase;
            
            console.log(`🔄 Смена фазы: ${oldPhase} → ${phase}`);
            
            // Обновляем UI
            updatePhaseUI();
            
            // UI участника (дополнительно к updatePhaseUI, на случай если экран уже отрисован)
            if (!state.user.isModerator) {
                renderParameters();    // ползунки
                updateConfirmButton(); // кнопка
                showNotification(`Фаза ${phase}: ${CONFIG.phases[phase]?.name}`, 'success');
            }
            
            addToLog('phase', `Переход к фазе ${phase}: ${CONFIG.phases[phase]?.name}`);
        }
    });

    // Сообщения модератора
    sessionRef.child('broadcasts').limitToLast(20).on('child_added', (snapshot) => {
        const payload = snapshot.val();
        if (!payload?.message) return;
        // Не показываем самому себе, если это модератор в той же вкладке
        if (payload.from && payload.from === state.user.name && state.user.isModerator) return;
        showBroadcast(payload.message, payload);
    });

    // События модератора (интермиссия и т.п.)
    sessionRef.child('events').limitToLast(20).on('child_added', (snapshot) => {
        const event = snapshot.val();
        if (!event?.effect) return;
        
        // Участники применяют эффекты
        if (!state.user.isModerator) {
            applyEventEffect(event);
            renderParameters();
            updateConfirmButton();
            showNotification(`Событие: ${event.name || 'изменение условий'}`, 'warning');
        }
    });
    
    console.log(`📡 Подписка на сессию ${sessionCode}`);
}

// Синхронизация метаданных сессии из Firebase (без фазы)
function syncSessionDataFromFirebase(sessionData) {
    if (!sessionData) return;
    
    // createdAt может быть строкой
    const createdAt = sessionData.createdAt ? new Date(sessionData.createdAt) : state.session.createdAt;
    
    // Игнорируем sessionData.phase: фазу обрабатываем ТОЛЬКО из sessions/{code}/phase
    const { phase, ...rest } = sessionData;
    state.session = { ...state.session, ...rest, createdAt };
    
    // Обновляем заголовки/баннеры (фаза уже в state.session.phase)
    updatePhaseUI();
}

// Сохранение сессии в Firebase
function saveSessionToFirebase() {
    // Локальный режим: сохраняем в localStorage и оповещаем вкладки
    if (!firebaseEnabled) {
        if (!state.session.code) return;
        const existing = localReadSession(state.session.code) || {};
        const data = {
            session: {
                name: state.session.name,
                isPaused: state.session.isPaused,
                projectScale: state.session.projectScale,
                budgetLevel: state.session.budgetLevel,
                budgetTotal: state.session.budgetTotal,
                budgetUsed: state.session.budgetUsed,
                createdAt: state.session.createdAt ? state.session.createdAt.toISOString() : null
            },
            phase: state.session.phase,
            participants: existing.participants || {},
            teams: existing.teams || {},
            decisions: existing.decisions || {}
        };
        localWriteSession(state.session.code, data);
        localBroadcast({ type: 'session_update', code: state.session.code, data });
        return;
    }
    if (!state.session.code) {
        console.log('⚠️ saveSessionToFirebase: нет кода сессии');
        return;
    }
    
    const sessionRef = firebaseDB.ref(`sessions/${state.session.code}`);
    
    // ВАЖНО: нельзя делать update() с пересекающимися путями вида { session: {...}, 'session/phase': null }
    // поэтому пишем session/* "плоско".
    const data = {
        'session/name': state.session.name,
        'session/isPaused': state.session.isPaused,
        'session/projectScale': state.session.projectScale,
        'session/budgetLevel': state.session.budgetLevel,
        'session/budgetTotal': state.session.budgetTotal,
        'session/createdAt': state.session.createdAt?.toISOString() || null,
        // Фаза хранится отдельным полем (sessions/{code}/phase)
        phase: state.session.phase,
        // Удаляем устаревшее поле session/phase (иначе старые клиенты могут откатывать фазу)
        'session/phase': null
    };
    
    console.log('💾 Сохраняю сессию в Firebase:', data);
    
    sessionRef.update(data).then(() => {
        console.log('✅ Сессия сохранена в Firebase');
    }).catch((error) => {
        console.error('❌ Ошибка сохранения сессии:', error);
        if (isFirebasePermissionDenied(error)) {
            const msg = 'Не удалось сохранить сессию в Firebase (PERMISSION_DENIED). Проверьте Rules в Realtime Database: запись/чтение сейчас запрещены для неавторизованных пользователей.';
            showNotification(msg, 'error', 20000);
            showCritical(msg, error);
        } else {
            showNotification('Не удалось сохранить сессию в Firebase. Проверьте соединение и попробуйте снова.', 'error', 12000);
        }
    });
}

// Сохранение участника в Firebase
function saveParticipantToFirebase(participant) {
    // Локальный режим
    if (!firebaseEnabled) {
        if (!state.session.code) return;
        const existing = localReadSession(state.session.code);
        if (!existing) {
            console.warn('⚠️ LocalSync: сессия не найдена для сохранения участника');
            return;
        }
        existing.participants = existing.participants || {};
        existing.participants[participant.id] = participant;
        localWriteSession(state.session.code, existing);
        localBroadcast({ type: 'participants_child_added', code: state.session.code, participant });
        // Также шлём полный слепок (на случай позднего подключения вкладки)
        localBroadcast({ type: 'session_update', code: state.session.code, data: existing });
        return;
    }
    if (!state.session.code) {
        console.log('⚠️ saveParticipantToFirebase: нет кода сессии');
        return;
    }
    
    console.log('💾 Сохраняю участника в Firebase:', participant.name, 'ID:', participant.id);
    
    const participantRef = firebaseDB.ref(`sessions/${state.session.code}/participants/${participant.id}`);
    participantRef.set(participant).then(() => {
        console.log('✅ Участник сохранён в Firebase:', participant.name);
    }).catch((error) => {
        console.error('❌ Ошибка сохранения участника:', error);
        if (isFirebasePermissionDenied(error)) {
            const msg = 'Firebase запрещает сохранять участника (PERMISSION_DENIED). Проверьте Rules в Realtime Database.';
            showNotification(msg, 'error', 20000);
            showCritical(msg, error);
        }
    });
}

// Сохранение данных команды в Firebase
function saveTeamToFirebase(teamId) {
    // Локальный режим
    if (!firebaseEnabled) {
        if (!state.session.code) return;
        const existing = localReadSession(state.session.code);
        if (!existing) {
            console.warn('⚠️ LocalSync: сессия не найдена для сохранения команды');
            return;
        }
        existing.teams = existing.teams || {};
        existing.teams[teamId] = state.teamsData[teamId];
        localWriteSession(state.session.code, existing);
        localBroadcast({ type: 'teams_update', code: state.session.code, teams: { [teamId]: existing.teams[teamId] } });
        return;
    }
    if (!state.session.code) {
        console.log('⚠️ saveTeamToFirebase: нет кода сессии');
        return;
    }
    
    const teamData = state.teamsData[teamId];
    console.log(`💾 Сохраняю команду ${teamId} в Firebase:`, {
        confirmed: teamData.confirmed,
        parametersCount: teamData.parameters.length
    });
    
    const teamRef = firebaseDB.ref(`sessions/${state.session.code}/teams/${teamId}`);
    teamRef.set(teamData).then(() => {
        console.log(`✅ Команда ${teamId} сохранена в Firebase`);
    }).catch((error) => {
        console.error(`❌ Ошибка сохранения команды ${teamId}:`, error);
        if (isFirebasePermissionDenied(error)) {
            const msg = 'Firebase запрещает сохранять команды (PERMISSION_DENIED). Проверьте Rules в Realtime Database.';
            showNotification(msg, 'error', 20000);
            showCritical(msg, error);
        }
    });
}

// Обновление фазы в Firebase
function updatePhaseInFirebase(phase) {
    // Локальный режим
    if (!firebaseEnabled) {
        if (!state.session.code) return;
        const existing = localReadSession(state.session.code);
        if (existing) {
            existing.phase = phase;
            if (existing.session) existing.session.phase = phase;
            localWriteSession(state.session.code, existing);
            localBroadcast({ type: 'phase_update', code: state.session.code, phase });
            localBroadcast({ type: 'session_update', code: state.session.code, data: existing });
        }
        return;
    }
    if (!state.session.code) {
        console.log('⚠️ updatePhaseInFirebase: нет кода сессии');
        return;
    }
    
    console.log('📤 Отправляю фазу в Firebase:', phase);
    
    const sessionRef = firebaseDB.ref(`sessions/${state.session.code}`);
    sessionRef.update({ phase: phase }).then(() => {
        console.log('✅ Фаза отправлена в Firebase');
    }).catch((error) => {
        console.error('❌ Ошибка отправки фазы:', error);
    });
}

// Debounce для сохранения команды (чтобы не спамить Firebase при перетаскивании слайдера)
let saveTeamTimeout = {};
function debounceSaveTeam(teamId, delay = 300) {
    if (saveTeamTimeout[teamId]) {
        clearTimeout(saveTeamTimeout[teamId]);
    }
    saveTeamTimeout[teamId] = setTimeout(() => {
        saveTeamToFirebase(teamId);
    }, delay);
}

// =====================================================
// РЕШЕНИЯ УЧАСТНИКОВ (новая модель) + АГРЕГАЦИЯ ПО КОМАНДЕ
// =====================================================

function createDefaultParametersArray() {
    const all = getAllParameters();
    return all.map(p => ({ id: p.id, value: p.default }));
}

function normalizeDecision(decisionLike) {
    if (!decisionLike || typeof decisionLike !== 'object') return null;
    const teamId = decisionLike.teamId || decisionLike.team?.id || (typeof decisionLike.team === 'string' ? decisionLike.team : null);
    const rawParams = Array.isArray(decisionLike.parameters) ? decisionLike.parameters : null;
    const parameters = rawParams
        ? rawParams.map(p => ({ id: p.id, value: Number(p.value) }))
        : createDefaultParametersArray();
    return {
        teamId,
        parameters,
        confirmed: !!decisionLike.confirmed,
        confirmedPhase: typeof decisionLike.confirmedPhase === 'number' ? decisionLike.confirmedPhase : null,
        updatedAt: decisionLike.updatedAt || null
    };
}

function normalizeDecisionsMap(mapLike) {
    const out = {};
    if (!mapLike || typeof mapLike !== 'object') return out;
    Object.keys(mapLike).forEach(pid => {
        const norm = normalizeDecision(mapLike[pid]);
        if (norm) out[pid] = norm;
    });
    return out;
}

function ensureParticipantDecision(participantId, teamId = null) {
    if (!participantId) return null;
    if (!state.participantDecisions) state.participantDecisions = {};
    if (state.participantDecisions[participantId]) return state.participantDecisions[participantId];
    const inferredTeamId = teamId || getParticipantTeamId(state.participants.find(p => p.id === participantId)) || null;
    state.participantDecisions[participantId] = {
        teamId: inferredTeamId,
        parameters: createDefaultParametersArray(),
        confirmed: false,
        confirmedPhase: null,
        updatedAt: null
    };
    return state.participantDecisions[participantId];
}

function getDecisionForParticipant(participantId) {
    return ensureParticipantDecision(participantId);
}

function isParticipantConfirmedForPhase(participantId, phase) {
    const d = state.participantDecisions?.[participantId];
    if (!d?.confirmed) return false;
    if (typeof d.confirmedPhase !== 'number') return false;
    return d.confirmedPhase === Number(phase);
}

function getTeamDecisionProgress(teamId, phase) {
    const members = getTeamMembers(teamId);
    const total = members.length;
    const confirmed = members.filter(m => isParticipantConfirmedForPhase(m.id, phase)).length;
    return { confirmed, total };
}

function computeAggregatedTeamParameters(teamId, override = null) {
    const members = getTeamMembers(teamId);
    const allParams = getAllParameters();
    if (!members || members.length === 0) {
        return allParams.map(p => ({ id: p.id, value: p.default }));
    }
    return allParams.map(paramDef => {
        let sum = 0;
        let n = 0;
        members.forEach(m => {
            const decision = state.participantDecisions?.[m.id];
            let v = decision?.parameters?.find(x => x.id === paramDef.id)?.value;
            if (override && m.id === override.participantId && paramDef.id === override.paramId) v = override.value;
            if (typeof v !== 'number' || Number.isNaN(v)) v = paramDef.default;
            sum += v;
            n += 1;
        });
        return { id: paramDef.id, value: sum / Math.max(1, n) };
    });
}

function recomputeTeamAggregate(teamId) {
    if (!teamId) return;
    const teamData = initTeamData(teamId);
    const hasAnyDecisions = getTeamMembers(teamId).some(m => !!state.participantDecisions?.[m.id]);
    if (!hasAnyDecisions) return;
    teamData.parameters = computeAggregatedTeamParameters(teamId);
    // Команда считается "подтвердившей" только в фазах ввода и только если все её участники подтвердили
    const phase = Number(state.session.phase);
    const isInputPhase = (phase === 1 || phase === 4);
    const prog = getTeamDecisionProgress(teamId, phase);
    teamData.confirmed = isInputPhase && prog.total > 0 && prog.confirmed === prog.total;
    teamData._progress = prog;
}

function recomputeAllTeamAggregates() {
    const teams = getActiveTeams();
    teams.forEach(t => recomputeTeamAggregate(t.id));
}

// Сохранение решения участника в Firebase/LocalSync
function saveParticipantDecision(participantId) {
    if (!participantId || !state.session.code) return;
    const decision = state.participantDecisions?.[participantId];
    if (!decision) return;
    decision.updatedAt = new Date().toISOString();
    // teamId может быть не проставлен, добьём
    if (!decision.teamId) decision.teamId = getParticipantTeamId(state.participants.find(p => p.id === participantId)) || null;

    // Локальный режим
    if (!firebaseEnabled) {
        const existing = localReadSession(state.session.code);
        if (!existing) return;
        existing.decisions = existing.decisions || {};
        existing.decisions[participantId] = decision;
        localWriteSession(state.session.code, existing);
        localBroadcast({ type: 'decisions_update', code: state.session.code, decisions: existing.decisions });
        // также шлём полный слепок на всякий случай
        localBroadcast({ type: 'session_update', code: state.session.code, data: existing });
        return;
    }

    try {
        const ref = firebaseDB.ref(`sessions/${state.session.code}/decisions/${participantId}`);
        ref.set(decision).catch((e) => {
            console.error('❌ Ошибка сохранения решения участника:', e);
            showNotification('Не удалось сохранить ваше решение (Firebase).', 'error', 8000);
        });
    } catch (e) {
        console.error('❌ Ошибка сохранения решения участника:', e);
    }
}

let saveDecisionTimeout = {};
function debounceSaveDecision(participantId, delay = 300) {
    if (saveDecisionTimeout[participantId]) clearTimeout(saveDecisionTimeout[participantId]);
    saveDecisionTimeout[participantId] = setTimeout(() => saveParticipantDecision(participantId), delay);
}

// =====================================================
// КОНФИГУРАЦИЯ И КОНСТАНТЫ
// =====================================================

const CONFIG = {
    // =====================================================
    // МОДЕЛЬ ИГС (Индекс Городской Среды)
    // ИГС = 0.20×G + 0.15×F + 0.15×T + 0.15×S + 0.15×C − 0.10×P − 0.10×D
    // =====================================================
    
    // Пресеты масштаба проекта
    projectScales: {
        small: { 
            name: 'Малый (двор/сквер)', 
            area: '0.5–2 га', 
            population: '500–2000 чел',
            icon: '🏡'
        },
        medium: { 
            name: 'Средний (квартал)', 
            area: '2–10 га', 
            population: '2000–10000 чел',
            icon: '🏘️'
        },
        large: { 
            name: 'Крупный (микрорайон)', 
            area: '10–50 га', 
            population: '10000–50000 чел',
            icon: '🏙️'
        }
    },
    
    // Пресеты бюджета
    budgetLevels: {
        low: { 
            name: 'Ограниченный', 
            multiplier: 0.6, 
            desc: 'Минимальное финансирование',
            icon: '💰',
            totalPoints: 800
        },
        medium: { 
            name: 'Стандартный', 
            multiplier: 1.0, 
            desc: 'Типичный бюджет благоустройства',
            icon: '💰💰',
            totalPoints: 1200
        },
        high: { 
            name: 'Расширенный', 
            multiplier: 1.5, 
            desc: 'Приоритетный проект',
            icon: '💰💰💰',
            totalPoints: 1800
        }
    },

    // Лимит "ходов" (кол-во разных ползунков, которые капитан может изменить за фазу ввода)
    // Связано с уровнем бюджета, как вы просили: 800→4, 1200→6, 1800→8
    moveLimitsByBudgetLevel: {
        low: 4,
        medium: 6,
        high: 8
    },
    
    // Стоимость изменения параметров (очков за +10 единиц)
    parameterCosts: {
        Z: 15,   // Озеленение дорого
        R: 8,
        Tg: 10,
        N: 12,   // Функции средне
        Df: 6,
        Af: 10,
        M: 20,   // Транспорт очень дорого
        Pt: 8,
        B: 12,
        I: 15,   // Инклюзивность дорого
        U: 10,
        As: 5,   // Участие дёшево
        O: 8,
        V: 6,
        L: 12,   // Шумоизоляция дорого
        Ca: -5,  // Твёрдое покрытие даёт экономию
        Tp: -3   // Трафик тоже экономия
    },
    
    // Веса компонентов ИГС
    igsWeights: {
        G: 0.20,   // Озеленение (UN-Habitat)
        F: 0.15,   // Функции (15-минутный город)
        T: 0.15,   // Транспорт (Urban Audit)
        S: 0.15,   // Инклюзивность (UN-Habitat)
        C: 0.15,   // Комфорт («Города для людей»)
        P: -0.10,  // Напряжённость (штраф)
        D: -0.10   // Конфликт интересов (штраф)
    },
    
    // Категории параметров с подформулами
    parameterCategories: [
        {
            id: 'G',
            name: 'Озеленение',
            icon: '🌳',
            color: '#10b981',
            weight: 0.20,
            source: 'UN-Habitat (≥15–20 м²/чел)',
            params: [
                { id: 'Z', name: 'Доля зелёных зон', desc: 'Процент территории, занятой зелёными насаждениями', weight: 0.5, min: 0, max: 100, default: 30, unit: '%' },
                { id: 'R', name: 'Равномерность озеленения', desc: 'Насколько равномерно распределены зелёные зоны', weight: 0.3, min: 0, max: 100, default: 50, unit: '' },
                { id: 'Tg', name: 'Тенистость', desc: 'Доступ к тени в жаркое время года', weight: 0.2, min: 0, max: 100, default: 40, unit: '%' }
            ]
        },
        {
            id: 'F',
            name: 'Функции',
            icon: '🏪',
            color: '#f59e0b',
            weight: 0.15,
            source: '15-минутный город',
            params: [
                { id: 'N', name: 'Количество функций', desc: 'Разнообразие: торговля, спорт, отдых, детские зоны', weight: 0.4, min: 0, max: 100, default: 40, unit: '' },
                { id: 'Df', name: 'Распределение функций', desc: 'Равномерность размещения функций по территории', weight: 0.3, min: 0, max: 100, default: 50, unit: '' },
                { id: 'Af', name: 'Активность фасадов', desc: 'Наличие витрин, входов, визуального контакта', weight: 0.3, min: 0, max: 100, default: 45, unit: '' }
            ]
        },
        {
            id: 'T',
            name: 'Транспорт',
            icon: '🚌',
            color: '#3b82f6',
            weight: 0.15,
            source: 'Urban Audit',
            params: [
                { id: 'M', name: 'Близость ОТ', desc: 'Доступность общественного транспорта (≤500м)', weight: 0.4, min: 0, max: 100, default: 60, unit: '' },
                { id: 'Pt', name: 'Проницаемость', desc: 'Удобство пешеходных маршрутов', weight: 0.4, min: 0, max: 100, default: 50, unit: '' },
                { id: 'B', name: 'Велоинфраструктура', desc: 'Наличие велодорожек и парковок для велосипедов', weight: 0.2, min: 0, max: 100, default: 30, unit: '' }
            ]
        },
        {
            id: 'S',
            name: 'Инклюзивность',
            icon: '♿',
            color: '#8b5cf6',
            weight: 0.15,
            source: 'UN-Habitat',
            params: [
                { id: 'I', name: 'Безбарьерность', desc: 'Инклюзивный дизайн для МГН', weight: 0.5, min: 0, max: 100, default: 40, unit: '' },
                { id: 'U', name: 'Универсальность', desc: 'Пригодность для всех возрастов', weight: 0.3, min: 0, max: 100, default: 50, unit: '' },
                { id: 'As', name: 'Участие в решениях', desc: 'Вовлечённость жителей в проектирование', weight: 0.2, min: 0, max: 100, default: 30, unit: '' }
            ]
        },
        {
            id: 'C',
            name: 'Комфорт',
            icon: '💡',
            color: '#ec4899',
            weight: 0.15,
            source: '«Города для людей» (Gehl)',
            params: [
                { id: 'O', name: 'Освещённость', desc: 'Качество уличного освещения', weight: 0.4, min: 0, max: 100, default: 55, unit: '' },
                { id: 'V', name: 'Просматриваемость', desc: 'Визуальная безопасность пространства', weight: 0.3, min: 0, max: 100, default: 60, unit: '' },
                { id: 'L', name: 'Тишина', desc: 'Низкий уровень шума (100 = тихо)', weight: 0.3, min: 0, max: 100, default: 45, unit: '' }
            ]
        },
        {
            id: 'P',
            name: 'Напряжённость',
            icon: '⚠️',
            color: '#ef4444',
            weight: -0.10,
            source: 'ГОСТ Р 59289-2020',
            isNegative: true,
            params: [
                { id: 'Ca', name: 'Твёрдое покрытие', desc: 'Площадь асфальта и бетона', weight: 0.6, min: 0, max: 100, default: 60, unit: '%' },
                { id: 'Tp', name: 'Трафик', desc: 'Интенсивность автомобильного движения', weight: 0.4, min: 0, max: 100, default: 50, unit: '' }
            ]
        }
    ],
    
    // Фазы симуляции (обновлённые согласно сценарию)
    phases: [
        { id: 0, name: 'Вводная', desc: 'Знакомство с проектом, распределение ролей' },
        { id: 1, name: 'Раунд 1', desc: 'Первые решения команд' },
        { id: 2, name: 'Анализ Р1', desc: 'Обсуждение результатов, выявление конфликтов' },
        { id: 3, name: 'Интермиссия', desc: 'Событие от модератора' },
        { id: 4, name: 'Раунд 2', desc: 'Переговоры и компромиссы' },
        { id: 5, name: 'Итоги', desc: 'Финальный анализ и выводы' }
    ],
    
    // Шаблоны событий
    eventTemplates: {
        budget: {
            name: 'Сокращение бюджета',
            desc: 'Из-за экономической ситуации бюджет проекта сокращён на 20%. Необходимо пересмотреть приоритеты.',
            effect: 'limit_max',
            params: { parameter: 'budget', value: 80 }
        },
        protest: {
            name: 'Протест жителей',
            desc: 'Жители микрорайона выступают против высотной застройки. Требуется снизить плотность.',
            effect: 'limit_max',
            params: { parameter: 'density', value: 60 }
        },
        eco: {
            name: 'Экологическое требование',
            desc: 'Экологическая экспертиза требует увеличить озеленение минимум до 40%.',
            effect: 'limit_min',
            params: { parameter: 'green', value: 40 }
        },
        investor: {
            name: 'Интерес инвестора',
            desc: 'Крупный инвестор готов вложиться в проект при условии развития коммерческой инфраструктуры.',
            effect: 'none',
            params: {}
        },
        tech: {
            name: 'Технический сбой',
            desc: 'Обнаружены проблемы с инженерными сетями. Параметр транспорта временно заблокирован.',
            effect: 'lock',
            params: { parameter: 'transport' }
        },
        custom: {
            name: '',
            desc: '',
            effect: 'none',
            params: {}
        }
    },
    
    // Имена для ботов
    botNames: ['Алексей', 'Мария', 'Дмитрий', 'Елена', 'Сергей', 'Анна', 'Иван', 'Ольга'],
    
    // Реальные роли участников
    realRoles: {
        architect: { name: 'Архитектор', icon: '🏛️' },
        activist: { name: 'Активист', icon: '📢' },
        resident: { name: 'Местный житель', icon: '🏠' },
        admin: { name: 'Представитель администрации', icon: '🏢' },
        business: { name: 'Представитель бизнес-сообщества', icon: '💼' }
    },
    
    // Игровые роли (назначаются случайно, отличаются от реальной)
    gameRoles: [
        { id: 'architect', name: 'Архитектор', desc: 'Вы отстаиваете интересы архитектурного сообщества', icon: '🏛️' },
        { id: 'activist', name: 'Активист', desc: 'Вы защищаете права и интересы граждан', icon: '📢' },
        { id: 'resident', name: 'Местный житель', desc: 'Вы представляете интересы жителей района', icon: '🏠' },
        { id: 'admin', name: 'Чиновник', desc: 'Вы представляете интересы городской администрации', icon: '🏢' },
        { id: 'business', name: 'Предприниматель', desc: 'Вы представляете интересы бизнес-сообщества', icon: '💼' }
    ],
    
    // Команды (группы интересов в игре)
    // ВАЖНО: id остаются короткими (a/b/c/...), чтобы не ломать старые данные,
    // а отображаемые имена — «профессии/стороны», как в задании.
    teams: [
        { id: 'a', name: 'Архитекторы', color: '#06d6a0' },
        { id: 'b', name: 'Активисты', color: '#f59e0b' },
        { id: 'c', name: 'Жители', color: '#ec4899' },
        { id: 'd', name: 'Предприниматели', color: '#8b5cf6' },
        { id: 'e', name: 'Администрация', color: '#3b82f6' }
    ],
    
    // Привязка игровой роли (которую «отстаивает» участник) к команде.
    // Это делает команды осмысленными: команда = сторона интересов.
    teamByGameRole: {
        architect: 'a',
        activist: 'b',
        resident: 'c',
        business: 'd',
        admin: 'e'
    }
};

// =====================================================
// СОСТОЯНИЕ ПРИЛОЖЕНИЯ
// =====================================================

const state = {
    // Режим: 'login', 'participant', 'moderator'
    mode: 'login',
    
    // Информация о сессии
    session: {
        code: '',
        name: '',
        createdAt: null,
        phase: 0,
        isPaused: false,
        // Настройки проекта
        projectScale: 'medium',
        budgetLevel: 'medium',
        budgetUsed: 0,
        budgetTotal: 1200,
        // Снимки состояния для сравнения
        round1Snapshot: null,
        initialSnapshot: null
    },
    
    // Текущий пользователь
    user: {
        id: '',
        name: '',
        isModerator: false,
        realRole: null,      // Реальная роль участника
        gameRole: null,      // Назначенная игровая роль
        team: null           // Назначенная команда
    },
    
    // Участники сессии
    participants: [],

    // Решения участников (параметры + подтверждение на уровне участника)
    // { participantId: { teamId, parameters:[{id,value}], confirmed, confirmedPhase, updatedAt } }
    participantDecisions: {},
    
    // Данные команд (параметры хранятся на уровне команды, не участника)
    teamsData: {},  // { teamId: { parameters: [...], confirmed: false, captainId: null } }
    
    // Параметры
    parameters: [],
    
    // Блокировки параметров
    locks: {},
    
    // Ограничения параметров
    constraints: {},
    
    // История действий
    history: [],
    
    // Лог событий
    log: [],
    
    // Очередь событий
    eventsQueue: [],
    
    // Графики
    charts: {
        radar: null,
        timeline: null
    },
    
    // История значений для графиков
    timelineData: [],

    // UI-состояние (локально в памяти вкладки)
    ui: {
        categoryOpen: {} // { [categoryId]: boolean }
    }
};

// =====================================================
// УТИЛИТЫ
// =====================================================

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

function generateSessionCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function formatTime(date) {
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(date) {
    return date.toLocaleString('ru-RU', { 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric',
        hour: '2-digit', 
        minute: '2-digit' 
    });
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function $(selector) {
    if (!selector) return null;
    // В коде исторически используется $('#some-id') БЕЗ '#'.
    // Делаем функцию устойчивой: если это похоже на id — берём getElementById.
    if (typeof selector === 'string') {
        const s = selector.trim();
        const startsLikeCss = s.startsWith('#') || s.startsWith('.') || s.startsWith('[');
        const looksComplex = s.includes(' ') || s.includes('>') || s.includes(':') || s.includes(',') || s.includes('[');
        if (!startsLikeCss && !looksComplex) {
            return document.getElementById(s) || document.querySelector(s);
        }
        return document.querySelector(s);
    }
    return null;
}

function $$(selector) {
    return document.querySelectorAll(selector);
}

function onEl(el, eventName, handler, options) {
    if (!el || !el.addEventListener) return false;
    el.addEventListener(eventName, handler, options);
    return true;
}

function onId(idOrSelector, eventName, handler, options) {
    const el = $(idOrSelector);
    return onEl(el, eventName, handler, options);
}

// =====================================================
// РАСЧЁТ ИГС (Индекс Городской Среды)
// ИГС = 0.20×G + 0.15×F + 0.15×T + 0.15×S + 0.15×C − 0.10×P − 0.10×D
// =====================================================

// Получить плоский список всех параметров
function getAllParameters() {
    const params = [];
    CONFIG.parameterCategories.forEach(cat => {
        cat.params.forEach(p => {
            params.push({
                ...p,
                categoryId: cat.id,
                categoryName: cat.name,
                categoryColor: cat.color
            });
        });
    });
    return params;
}

// Расчёт компонента категории (G, F, T, S, C, P)
function calculateCategoryValue(categoryId, parameters) {
    const category = CONFIG.parameterCategories.find(c => c.id === categoryId);
    if (!category) return 0;
    
    let value = 0;
    category.params.forEach(paramDef => {
        const paramValue = parameters.find(p => p.id === paramDef.id)?.value ?? paramDef.default;
        value += paramDef.weight * paramValue;
    });
    
    return value;
}


// Полный расчёт ИГС для набора параметров
function calculateIGS(parameters, conflictValue = null) {
    const G = calculateCategoryValue('G', parameters);
    const F = calculateCategoryValue('F', parameters);
    const T = calculateCategoryValue('T', parameters);
    const S = calculateCategoryValue('S', parameters);
    const C = calculateCategoryValue('C', parameters);
    const P = calculateCategoryValue('P', parameters);
    const D = conflictValue !== null ? conflictValue : calculateConflict();
    
    const weights = CONFIG.igsWeights;
    
    // ИГС = 0.20×G + 0.15×F + 0.15×T + 0.15×S + 0.15×C − 0.10×P − 0.10×D
    const igs = (
        weights.G * G +
        weights.F * F +
        weights.T * T +
        weights.S * S +
        weights.C * C +
        weights.P * P +  // уже отрицательный вес
        weights.D * D    // уже отрицательный вес
    );
    
    return {
        total: Math.max(0, Math.min(100, igs)),
        components: { G, F, T, S, C, P, D },
        weights: weights
    };
}

// Расчёт ИГС для команды
function calculateTeamIGS(teamId) {
    const teamData = getTeamData(teamId);
    return calculateIGS(teamData.parameters);
}

// Расчёт среднего ИГС по всем командам
function calculateAverageIGS() {
    const activeTeams = getTeamsForAnalytics();
    if (activeTeams.length === 0) return null;
    
    // Собираем средние значения параметров
    const allParams = getAllParameters();
    const avgParameters = allParams.map(paramDef => {
        const teamValues = activeTeams.map(team => {
            const teamData = getTeamData(team.id);
            const param = teamData.parameters.find(p => p.id === paramDef.id);
            return param ? param.value : paramDef.default;
        });
        return {
            id: paramDef.id,
            value: teamValues.reduce((a, b) => a + b, 0) / teamValues.length
        };
    });
    
    return calculateIGS(avgParameters);
}

// =====================================================
// УПРАВЛЕНИЕ КОМАНДАМИ
// =====================================================

// Нормализация team из данных (поддержка старых форматов):
// - team может быть строкой (например "a")
// - team может быть объектом без name/color (добиваем из CONFIG)
function normalizeTeam(teamLike) {
    if (!teamLike) return null;
    
    // Старый формат: строка-id
    if (typeof teamLike === 'string') {
        const id = teamLike;
        const fromConfig = CONFIG.teams.find(t => t.id === id);
        return fromConfig ? { ...fromConfig } : { id, name: `Команда ${String(id).toUpperCase()}`, color: '#64748b' };
    }
    
    // Объект
    if (typeof teamLike === 'object') {
        const id = teamLike.id || teamLike.teamId || teamLike.code || null;
        if (!id) return null;
        const fromConfig = CONFIG.teams.find(t => t.id === id);
        return {
            id,
            name: teamLike.name || fromConfig?.name || `Команда ${String(id).toUpperCase()}`,
            color: teamLike.color || fromConfig?.color || '#64748b'
        };
    }
    
    return null;
}

function getParticipantTeamId(participant) {
    if (!participant) return null;
    if (typeof participant.team === 'string') return participant.team;
    return participant.team?.id || null;
}

function normalizeParticipant(participant) {
    if (!participant) return participant;
    const team = normalizeTeam(participant.team);
    return { ...participant, team };
}

// Инициализация данных команды
function initTeamData(teamId) {
    if (!state.teamsData[teamId]) {
        // Создаём параметры из новой структуры категорий
        const parameters = [];
        CONFIG.parameterCategories.forEach(cat => {
            cat.params.forEach(p => {
                parameters.push({ id: p.id, value: p.default });
            });
        });
        
        state.teamsData[teamId] = {
            parameters: parameters,
            confirmed: false,
            captainId: null,
            // Ограничение ходов (сколько разных ползунков трогали в текущей фазе ввода)
            movesPhase: null,
            movesUsed: [],
            round1Snapshot: null,  // Снимок после раунда 1
            igsHistory: []         // История ИГС
        };
    }
    return state.teamsData[teamId];
}

// Получить данные команды
function getTeamData(teamId) {
    return state.teamsData[teamId] || initTeamData(teamId);
}

// Проверить, является ли участник капитаном своей команды
function isCaptain(participantId) {
    const participant = state.participants.find(p => p.id === participantId);
    const teamId = getParticipantTeamId(participant);
    if (!participant || !teamId) return false;
    
    const teamData = getTeamData(teamId);
    return teamData.captainId === participantId;
}

// Назначить капитана команды (случайно из членов команды)
function assignTeamCaptain(teamId) {
    const teamMembers = state.participants.filter(p => getParticipantTeamId(p) === teamId);
    if (teamMembers.length === 0) return;
    
    const teamData = getTeamData(teamId);
    
    // Если капитан уже есть и он ещё в команде - не меняем
    if (teamData.captainId && teamMembers.find(m => m.id === teamData.captainId)) {
        return;
    }
    
    // Назначаем случайного капитана
    const captain = teamMembers[Math.floor(Math.random() * teamMembers.length)];
    teamData.captainId = captain.id;
    captain.isCaptain = true;
    
    addToLog('team', `${captain.name} назначен капитаном ${CONFIG.teams.find(t => t.id === teamId)?.name}`);
}

// Получить участников команды
function getTeamMembers(teamId) {
    return state.participants.filter(p => getParticipantTeamId(p) === teamId);
}

// Получить активные команды (с участниками)
function getActiveTeams() {
    const idsFromParticipants = state.participants.map(getParticipantTeamId).filter(Boolean);
    const idsFromTeamsData = Object.keys(state.teamsData || {});
    const activeTeamIds = [...new Set([...idsFromParticipants, ...idsFromTeamsData])];
    const activeSet = new Set(activeTeamIds);
    
    // Сначала — команды из CONFIG (в заданном порядке), затем — «неизвестные» (из данных)
    const fromConfig = CONFIG.teams.filter(t => activeSet.has(t.id));
    const extras = activeTeamIds
        .filter(id => !CONFIG.teams.find(t => t.id === id))
        .map(id => {
            // пытаемся взять объект команды из участника (если он есть), иначе делаем заглушку
            const fromParticipant = state.participants.find(p => getParticipantTeamId(p) === id)?.team;
            return normalizeTeam(fromParticipant) || normalizeTeam(id) || { id, name: `Команда ${String(id).toUpperCase()}`, color: '#64748b' };
        });
    
    return [...fromConfig, ...extras];
}

// Команды для аналитики/матрицы.
// Для модератора показываем ВСЕ команды (даже если участники ещё не успели подтянуться из Firebase),
// для участника — только активные команды (с участниками).
function getTeamsForAnalytics() {
    if (state.user?.isModerator) return CONFIG.teams;
    return getActiveTeams();
}

// Конфликт интересов D: среднее расхождение команд по всем параметрам.
// Возвращает число ~[0..100], где 0 = полное согласие.
function calculateConflict() {
    const teams = getTeamsForAnalytics();
    if (teams.length < 2) return 0;
    
    const allParams = getAllParameters();
    let totalDeviation = 0;
    let paramCount = 0;
    
    allParams.forEach(paramDef => {
        const teamValues = teams.map(team => {
            const teamData = getTeamData(team.id);
            const param = teamData.parameters.find(p => p.id === paramDef.id);
            return param ? param.value : paramDef.default;
        });
        
        const mean = teamValues.reduce((a, b) => a + b, 0) / teamValues.length;
        const deviation = teamValues.reduce((sum, v) => sum + Math.abs(v - mean), 0) / teamValues.length;
        totalDeviation += deviation;
        paramCount++;
    });
    
    return paramCount > 0 ? totalDeviation / paramCount : 0;
}

// =====================================================
// УВЕДОМЛЕНИЯ
// =====================================================

function showNotification(message, type = 'info', durationMs = null) {
    const container = $('#notifications');
    const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ'
    };
    
    const defaultDuration = {
        success: 4500,
        info: 5000,
        warning: 8000,
        error: 12000
    };
    const ttl = typeof durationMs === 'number' ? durationMs : (defaultDuration[type] ?? 5000);
    
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <span class="notification-icon">${icons[type]}</span>
        <span class="notification-text">${message}</span>
    `;
    
    container.appendChild(notification);
    
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100px)';
        setTimeout(() => notification.remove(), 300);
    }, ttl);
}

function isFirebasePermissionDenied(err) {
    const code = err?.code || '';
    const msg = (err?.message || String(err || '')).toLowerCase();
    return code === 'PERMISSION_DENIED' || msg.includes('permission_denied') || msg.includes('permission denied');
}

function showCritical(message, error = null) {
    console.error('❌ CRITICAL:', message, error);
    // alert — чтобы пользователь точно увидел проблему (особенно на GitHub Pages)
    try {
        const details = error?.code ? `\n\nКод: ${error.code}` : '';
        const text = `${message}${details}`;
        alert(text);
    } catch (_) {}
}

// =====================================================
// НАВИГАЦИЯ МЕЖДУ ЭКРАНАМИ
// =====================================================

function showScreen(screenId) {
    $$('.screen').forEach(screen => screen.classList.remove('active'));
    $(`#${screenId}`).classList.add('active');
    state.mode = screenId.replace('-screen', '');
}

// =====================================================
// ЭКРАН ВХОДА
// =====================================================

function initLoginScreen() {
    // Подстраховка: на старых/битых состояниях кнопки могли остаться disabled/busy
    try {
        const joinBtn = $('#join-btn');
        if (joinBtn) { joinBtn.disabled = false; joinBtn.dataset.busy = '0'; joinBtn.textContent = joinBtn.textContent || 'Войти как участник'; }
        const createBtn = $('#create-btn');
        if (createBtn) { createBtn.disabled = false; createBtn.dataset.busy = '0'; createBtn.textContent = createBtn.textContent || '🚀 Создать сессию'; }
    } catch (_) {}

    // Стартовое состояние вкладок (если HTML/кэш “уехал”)
    try {
        const joinForm = $('#join-form') || $('#join-form'.replace('#',''));
        const createForm = $('#create-form') || $('#create-form'.replace('#',''));
        if (joinForm && joinForm.classList) joinForm.classList.remove('hidden');
        if (createForm && createForm.classList) createForm.classList.add('hidden');
        $$('.login-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'join'));
    } catch (_) {}

    // Табы входа
    $$('.login-tabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.login-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const tab = btn.dataset.tab;
            $('#join-form').classList.toggle('hidden', tab !== 'join');
            $('#create-form').classList.toggle('hidden', tab !== 'create');
        });
    });
    
    // Присоединиться к сессии
    onId('join-btn', 'click', () => {
        const joinBtn = $('#join-btn');
        const prevText = joinBtn?.textContent || '';
        try {
            if (joinBtn?.dataset?.busy === '1') return;
            if (joinBtn) {
                joinBtn.dataset.busy = '1';
                joinBtn.disabled = true;
                joinBtn.textContent = 'Подключаюсь…';
            }

            const codeEl = $('#session-code');
            const nameEl = $('#participant-name');
            const roleEl = $('#participant-real-role');
            const code = (codeEl?.value || '').trim().toUpperCase();
            const name = (nameEl?.value || '').trim();
            const realRole = (roleEl?.value || '');

            if (!code || code.length !== 6) {
                showNotification('Введите корректный код сессии (6 символов)', 'error');
                return;
            }
            if (!name) {
                showNotification('Введите ваше имя', 'error');
                return;
            }
            if (!realRole) {
                showNotification('Выберите вашу реальную роль', 'error');
                return;
            }

            showNotification('Подключаюсь к сессии…', 'info');
            joinSession(code, name, realRole)
                .catch(() => {}) // joinSession сам показывает сообщения об ошибках
                .finally(() => {});
        } catch (e) {
            console.error('❌ Ошибка при попытке входа участника:', e);
            showNotification('Не удалось выполнить вход. Откройте консоль (F12) для деталей.', 'error', 12000);
        } finally {
            if (joinBtn) {
                joinBtn.dataset.busy = '0';
                joinBtn.disabled = false;
                joinBtn.textContent = prevText || 'Войти как участник';
            }
        }
    });
    
    // Создать сессию
    onId('create-btn', 'click', () => {
        const createBtn = $('#create-btn');
        const prevText = createBtn?.textContent || '';
        try {
            if (createBtn?.dataset?.busy === '1') return;
            if (createBtn) {
                createBtn.dataset.busy = '1';
                createBtn.disabled = true;
                createBtn.textContent = 'Создаю…';
            }

            const sessionName = ($('#session-name')?.value || '').trim() || 'Новый проект';
            const customCode = ($('#session-code-input')?.value || '').trim().toUpperCase();
            const moderatorName = ($('#moderator-name')?.value || '').trim() || 'Модератор';

            // Получаем настройки проекта из select
            const projectScale = $('#project-scale')?.value || 'medium';
            const budgetLevel = $('#budget-level')?.value || 'medium';

            // Валидация кода, если введён
            if (customCode && !/^[A-Z0-9]{1,6}$/.test(customCode)) {
                showNotification('Код сессии: только латиница и цифры (до 6 символов)', 'error');
                return;
            }

            showNotification('Создаю сессию…', 'info');
            Promise.resolve(createSession(sessionName, moderatorName, customCode, projectScale, budgetLevel))
                .catch(() => {})
                .finally(() => {});
        } catch (e) {
            console.error('❌ Ошибка при создании сессии:', e);
            showNotification('Не удалось создать сессию. Откройте консоль (F12) для деталей.', 'error', 12000);
        } finally {
            if (createBtn) {
                createBtn.dataset.busy = '0';
                createBtn.disabled = false;
                createBtn.textContent = prevText || '🚀 Создать сессию';
            }
        }
    });
    
    // Демо-режим
    $('#demo-btn').addEventListener('click', startDemo);

    // Маркер: обработчики логина навешаны
    try {
        if (!state.ui) state.ui = { categoryOpen: {} };
        state.ui.loginHandlersReady = true;
    } catch (_) {}
}

function joinSession(code, name, realRole) {
    console.log('🔄 Попытка входа в сессию:', code);
    
    // Если Firebase включен - сначала проверяем существование сессии
    if (firebaseEnabled) {
        const sessionRef = firebaseDB.ref(`sessions/${code}`);
        
        // Иногда при плохом интернете запрос может «повиснуть» без ошибки.
        // Делаем таймаут, чтобы пользователь не застревал на "Подключаюсь…".
        return withTimeout(sessionRef.once('value'), 8000, 'Не удалось подключиться к Firebase (таймаут)')
        .then((snapshot) => {
            const sessionData = snapshot.val();
            
            if (!sessionData) {
                showNotification('Сессия не найдена! Проверьте код.', 'error');
                return Promise.reject(new Error('Session not found'));
            }
            
            console.log('✅ Сессия найдена:', sessionData);
            
            // Загружаем данные сессии
            if (sessionData.session) {
                // Игнорируем session.phase — фазу берём из sessionData.phase (root)
                const createdAt = sessionData.session.createdAt ? new Date(sessionData.session.createdAt) : null;
                const { phase, ...rest } = sessionData.session;
                state.session = { ...state.session, ...rest, createdAt };
            }
            state.session.code = code;
            state.session.phase = sessionData.phase || 0;
            
            // Теперь подключаем участника
            completeJoinSession(code, name, realRole);
            
            return true;
        }).catch((error) => {
            console.error('❌ Ошибка Firebase:', error);
            const offlineHint = (typeof navigator !== 'undefined' && navigator && navigator.onLine === false)
                ? ' Похоже, нет интернета.'
                : '';
            
            // Самая частая причина на GitHub Pages: правила Realtime Database закрыты (PERMISSION_DENIED)
            if (isFirebasePermissionDenied(error)) {
                const msg = 'Нет доступа к Firebase (PERMISSION_DENIED). Скорее всего, правила Realtime Database запрещают чтение/запись без авторизации (часто после окончания test mode). Откройте правила в Firebase Console или включите авторизацию/анонимный доступ.';
                showNotification(msg, 'error', 20000);
                showCritical(msg, error);
            } else if ((error?.message || '').toLowerCase().includes('таймаут')) {
                const msg = `Firebase не отвечает (таймаут). Проверьте доступ к доменам googleapis/gstatic/firebase и корпоративные блокировки.${offlineHint}`;
                showNotification(msg, 'error', 20000);
                showCritical(msg, error);
            } else {
                showNotification(`Ошибка подключения.${offlineHint} Попробуйте снова.`, 'error', 12000);
            }
            throw error;
        });
    } else {
        // Без Firebase — подключаемся к локальной сессии (между вкладками)
        initLocalSync();
        const localSession = localReadSession(code);
        if (!localSession) {
            showNotification('Сессия не найдена (локально). Создайте её в другой вкладке или включите Firebase.', 'error');
            return Promise.reject(new Error('Local session not found'));
        }
        
        // Загружаем данные сессии из localStorage
        if (localSession.session) {
            // createdAt может быть строкой
            const createdAt = localSession.session.createdAt ? new Date(localSession.session.createdAt) : null;
            state.session = { ...state.session, ...localSession.session, createdAt };
        }
        state.session.code = code;
        state.session.phase = typeof localSession.phase === 'number' ? localSession.phase : (state.session.phase || 0);
        
        // Подключаем участника
        completeJoinSession(code, name, realRole);
        return Promise.resolve(true);
    }
}

function completeJoinSession(code, name, realRole) {
    state.session.code = code;
    state.user.id = generateId();
    state.user.name = name;
    state.user.isModerator = false;
    state.user.realRole = realRole;
    
    // Сначала загружаем существующих участников из Firebase
    if (firebaseEnabled) {
        const sessionRef = firebaseDB.ref(`sessions/${code}`);
        sessionRef.child('participants').once('value', (snapshot) => {
            const existingParticipants = snapshot.val();
            if (existingParticipants) {
                console.log('👥 Загружаю существующих участников перед подключением:', Object.keys(existingParticipants).length);
                state.participants = [];
                Object.values(existingParticipants).forEach(p => {
                    state.participants.push(normalizeParticipant(p));
                });
            }
            
            // Теперь добавляем себя
            completeJoinSessionStep2(code, name, realRole);
        });
    } else {
        completeJoinSessionStep2(code, name, realRole);
    }
}

function completeJoinSessionStep2(code, name, realRole) {
    // Назначаем игровую роль (ОТЛИЧНУЮ от реальной)
    const availableGameRoles = CONFIG.gameRoles.filter(r => r.id !== realRole);
    
    // Подбираем роль так, чтобы команды были более-менее сбалансированы,
    // а команда соответствовала «стороне» (роль → teamByGameRole).
    const roleCandidates = availableGameRoles
        .map(role => {
            const teamId = CONFIG.teamByGameRole?.[role.id] || null;
            const count = teamId ? state.participants.filter(p => getParticipantTeamId(p) === teamId).length : Number.MAX_SAFE_INTEGER;
            return { role, teamId, count };
        })
        .filter(x => x.teamId);
    
    roleCandidates.sort((a, b) => a.count - b.count);
    const chosen = roleCandidates.length > 0
        ? roleCandidates[0]
        : { role: availableGameRoles[Math.floor(Math.random() * availableGameRoles.length)], teamId: null, count: 0 };
    
    const assignedRole = chosen.role;
    state.user.gameRole = assignedRole;
    
    // Команда соответствует игровой роли (стороне интересов)
    const teamIdFromRole = chosen.teamId || CONFIG.teamByGameRole?.[assignedRole.id] || null;
    const assignedTeam = (teamIdFromRole ? CONFIG.teams.find(t => t.id === teamIdFromRole) : null)
        || CONFIG.teams[0];
    state.user.team = assignedTeam;
    
    // Инициализируем параметры из новой структуры
    state.parameters = getAllParameters();
    
    // Инициализируем данные команды
    initTeamData(assignedTeam.id);
    
    // Добавляем себя в участники
    const participant = {
        id: state.user.id,
        name: name,
        isBot: false,
        realRole: state.user.realRole,
        gameRole: assignedRole,
        team: assignedTeam,
        isCaptain: false
    };
    state.participants.push(participant);

    // Инициализируем решение участника (его личные параметры)
    ensureParticipantDecision(participant.id, assignedTeam.id);
    try { recomputeTeamAggregate(assignedTeam.id); } catch (_) {}
    
    // Назначаем капитана команды
    assignTeamCaptain(assignedTeam.id);
    state.user.isCaptain = participant.isCaptain;
    
    // Подписываемся на обновления сессии
    subscribeToSession(code);
    
    // Сохраняем участника в Firebase
    saveParticipantToFirebase(participant);
    saveTeamToFirebase(assignedTeam.id);
    // Сохраняем начальное решение участника (чтобы оно участвовало в агрегации)
    saveParticipantDecision(participant.id);
    
    showScreen('participant-screen');
    initParticipantScreen();
    
    const captainMsg = state.user.isCaptain ? ' Вы — капитан команды!' : '';
    const phaseMsg = ` | Фаза: ${state.session.phase}`;
    showNotification(`Вы в ${assignedTeam.name}.${captainMsg}${phaseMsg}`, 'success');
    addToLog('join', `${name} (${CONFIG.realRoles[realRole].name}) → ${assignedTeam.name}`);
    
    console.log('✅ Участник подключен, текущая фаза:', state.session.phase);
}

function createSession(sessionName, moderatorName, customCode = '', projectScale = 'medium', budgetLevel = 'medium') {
    console.log('🎬 Создание новой сессии...');
    
    // ⚠️ СБРОС ВСЕХ ДАННЫХ для новой сессии
    state.participants = [];
    state.teamsData = {};
    state.participantDecisions = {};
    state.history = [];
    state.log = [];
    state.eventsQueue = [];
    state.timelineData = [];
    state.locks = {};
    state.constraints = {};
    
    // Используем пользовательский код или генерируем автоматически
    const code = customCode || generateSessionCode();
    
    state.session.code = code;
    state.session.name = sessionName;
    state.session.createdAt = new Date();
    state.session.phase = 0;
    state.session.round1Snapshot = null;
    state.session.initialSnapshot = null;
    
    // Настройки проекта
    state.session.projectScale = projectScale;
    state.session.budgetLevel = budgetLevel;
    state.session.budgetTotal = CONFIG.budgetLevels[budgetLevel].totalPoints;
    state.session.budgetUsed = 0;
    
    state.user.id = generateId();
    state.user.name = moderatorName;
    state.user.isModerator = true;
    
    console.log('👤 Модератор:', moderatorName, 'ID:', state.user.id);
    
    // Инициализируем параметры из новой структуры
    state.parameters = getAllParameters();

    // Инициализируем данные ВСЕХ команд сразу (чтобы матрица/метрики у модератора были видны даже без участников)
    try {
        CONFIG.teams.forEach(t => initTeamData(t.id));
    } catch (e) {
        console.warn('⚠️ Не удалось инициализировать команды при старте сессии:', e);
    }
    
    // Сохраняем начальное состояние
    state.session.initialSnapshot = JSON.parse(JSON.stringify(state.teamsData));
    
    // Сохраняем в Firebase
    saveSessionToFirebase();
    
    // Подписываемся на обновления ПОСЛЕ сохранения
    setTimeout(() => {
        console.log('📡 Подписываюсь на сессию как модератор');
        subscribeToSession(code);
    }, 100);
    
    showScreen('moderator-screen');
    initModeratorScreen();
    
    const scaleInfo = CONFIG.projectScales[projectScale];
    const budgetInfo = CONFIG.budgetLevels[budgetLevel];
    const firebaseStatus = firebaseEnabled ? '☁️ Онлайн' : '💻 Локально';
    showNotification(`Сессия создана! Код: ${code} | ${firebaseStatus}`, 'success');
    addToLog('system', `Проект "${sessionName}" | ${scaleInfo.icon} ${scaleInfo.name} | ${budgetInfo.icon} ${budgetInfo.name}`);
}

function startDemo() {
    createSession('Демо: Благоустройство парка', 'Модератор');
    
    // Добавляем демо-участников
    const demoParticipants = [
        { name: 'Анна К.', values: [45, 70, 55, 60, 30, 40] },
        { name: 'Игорь М.', values: [60, 50, 70, 45, 65, 55] },
        { name: 'Елена С.', values: [55, 80, 40, 70, 25, 35] },
        { name: 'Дмитрий В.', values: [70, 45, 60, 50, 55, 60] }
    ];
    
    demoParticipants.forEach((p, index) => {
        setTimeout(() => {
            addParticipant(p.name, false, p.values);
        }, (index + 1) * 500);
    });
    
    showNotification('Демо-режим активирован', 'info');
}

// =====================================================
// ЭКРАН УЧАСТНИКА
// =====================================================

function initParticipantScreen() {
    updateParticipantHeader();
    renderRoleCard();
    renderParameters();
    initHistoryPanel();
    initTerritoryMapControls();
    
    // Инициализируем ИГС Hero
    updateIGSHero();
    
    // Обновляем карту
    updateTerritoryMap();
    
    // Показываем текущую фазу
    updatePhaseUI();
    updateEventBanner(state.session.phase);
    
    // Автопрокрутка к игровому контенту (после входа)
    setTimeout(() => {
        const paramsSection = $('#parameters-section') || $('#parameters-grid') || $('#event-banner');
        if (paramsSection?.scrollIntoView) {
            paramsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }, 250);
    
    // Кнопка подтверждения
    $('#confirm-btn').addEventListener('click', confirmDecision);
}

function renderRoleCard() {
    const roleCard = $('#role-card');
    const gameRole = state.user.gameRole;
    const team = state.user.team;
    const userIsCaptain = isCaptain(state.user.id);
    
    if (gameRole && team) {
        const captainBadge = userIsCaptain ? ' 👑' : '';
        $('#role-name').textContent = `${gameRole.icon} ${gameRole.name}${captainBadge}`;
        $('#role-desc').textContent = `${gameRole.desc} Ваши настройки будут агрегироваться с решениями команды (среднее).`;
        $('#role-team').textContent = team.name + (userIsCaptain ? ' (капитан)' : '');
        $('#role-team').className = `role-team team-${team.id}`;
        roleCard.classList.remove('hidden');
        renderTeamMembersList();
    } else {
        roleCard.classList.add('hidden');
    }
}

function renderTeamMembersList() {
    const list = $('#team-members-list');
    const title = $('#team-members-title');
    if (!list) return;
    const teamId = state.user?.team?.id;
    if (!teamId) {
        list.innerHTML = '<div class="team-member-empty">Команда не определена</div>';
        return;
    }
    const members = getTeamMembers(teamId)
        .filter(p => p && p.id !== state.user.id)
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));

    if (title) title.textContent = `Сокомандники (${members.length + 1})`;

    if (members.length === 0) {
        list.innerHTML = '<div class="team-member-empty">Пока вы один(а) в команде</div>';
        return;
    }
    list.innerHTML = members.map(m => {
        const captainBadge = isCaptain(m.id) ? '👑 ' : '';
        return `<div class="team-member-row">${captainBadge}${escapeHtml(m.name || 'Без имени')}</div>`;
    }).join('');
}

function escapeHtml(str) {
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function updateParticipantHeader() {
    $('#p-session-code').textContent = state.session.code;
    $('#p-session-name').textContent = state.session.name;
    $('#p-phase').textContent = state.session.phase;
    $('#p-phase-title').textContent = CONFIG.phases[state.session.phase]?.name || '';
    $('#p-user-name').textContent = state.user.name;
}

function renderParameters() {
    const grid = $('#parameters-grid');
    grid.innerHTML = '';
    
    const currentPhase = Number(state.session.phase);
    const isInputPhase = (currentPhase === 1 || currentPhase === 4);
    const teamId = state.user.team?.id || null;
    const decision = ensureParticipantDecision(state.user.id, teamId);
    const participantParams = decision?.parameters || createDefaultParametersArray();
    const isConfirmed = isParticipantConfirmedForPhase(state.user.id, currentPhase);

    // Для подсказок: текущие командные значения (среднее)
    const teamAgg = teamId ? computeAggregatedTeamParameters(teamId) : [];
    const teamAggMap = new Map(teamAgg.map(p => [p.id, p.value]));
    
    // Рендерим параметры по категориям (аккордеон)
    CONFIG.parameterCategories.forEach(category => {
        if (!state.ui) state.ui = { categoryOpen: {} };
        if (!state.ui.categoryOpen) state.ui.categoryOpen = {};

        const details = document.createElement('details');
        details.className = 'param-category';
        details.dataset.categoryId = category.id;
        details.open = !!state.ui.categoryOpen[category.id]; // по умолчанию — закрыто

        const summary = document.createElement('summary');
        summary.className = 'param-category-header';
        summary.innerHTML = `
            <span class="category-icon">${category.icon}</span>
            <span class="category-name">${category.name}</span>
            <span class="category-weight" style="color: ${category.weight < 0 ? '#ef4444' : category.color}">
                ${category.weight > 0 ? '+' : ''}${(category.weight * 100).toFixed(0)}%
            </span>
            <span class="category-chevron" aria-hidden="true">▾</span>
        `;

        details.addEventListener('toggle', () => {
            state.ui.categoryOpen[category.id] = details.open;
        });

        details.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'param-category-body';
        details.appendChild(body);

        grid.appendChild(details);
        
        // Параметры категории
        category.params.forEach(param => {
            const isLocked = state.locks[param.id];
            const constraint = state.constraints[param.id] || {};
            const min = constraint.min ?? param.min;
            const max = constraint.max ?? param.max;
            
            // Значение — личное решение участника
            const myParam = participantParams.find(p => p.id === param.id);
            const value = (myParam && typeof myParam.value === 'number') ? myParam.value : param.default;
            const teamValue = teamAggMap.has(param.id) ? teamAggMap.get(param.id) : param.default;

            // Ползунок неактивен если заблокирован/не фаза ввода/участник уже подтвердил в этой фазе
            const isDisabled = isLocked || !isInputPhase || isConfirmed;
            
            const card = document.createElement('div');
            card.className = `param-card ${isLocked ? 'locked' : ''} ${isDisabled ? 'readonly' : ''}`;
            card.style.borderLeftColor = category.color;
            card.innerHTML = `
                <div class="param-header">
                    <span class="param-name">${param.name}</span>
                    <span class="param-value" id="value-${param.id}">${value}${param.unit}</span>
                </div>
                <p class="param-desc">${param.desc}</p>
                <div class="param-subvalue">Командное (среднее): ${Number(teamValue).toFixed(0)}${param.unit}</div>
                <div class="param-slider">
                    <input type="range" class="slider" id="slider-${param.id}" 
                           min="${min}" max="${max}" value="${value}"
                           ${isDisabled ? 'disabled' : ''}
                           style="--slider-color: ${category.color}">
                    <div class="slider-labels">
                        <span>${min}${param.unit}</span>
                        <span>${max}${param.unit}</span>
                    </div>
                </div>
                ${!isInputPhase
                    ? '<div class="param-notice">Изменения доступны только в фазах 1 и 4</div>'
                    : (isConfirmed
                        ? '<div class="param-notice">Вы подтвердили решение — изменения заблокированы до следующего раунда</div>'
                        : (isLocked
                            ? '<div class="param-notice">Параметр заблокирован событием/ограничением</div>'
                            : '<div class="param-notice">Настройте параметр — вклад будет учтён в среднем по команде</div>'))}
            `;
            
            body.appendChild(card);
            
            // Обработчик слайдера (каждый участник)
            if (!isLocked && isInputPhase && !isConfirmed) {
                const slider = card.querySelector(`#slider-${param.id}`);
                slider.addEventListener('input', (e) => {
                    const newValue = parseInt(e.target.value);
                    if (!teamId) return;
                    const myDecision = ensureParticipantDecision(state.user.id, teamId);
                    const myParams = myDecision?.parameters || (myDecision.parameters = createDefaultParametersArray());
                    const pRow = myParams.find(p => p.id === param.id);
                    const prevValue = pRow ? pRow.value : value;
                    if (pRow) pRow.value = newValue;

                    // Бюджет считаем по КОМАНДНОМУ (среднему) решению
                    const candidateAgg = computeAggregatedTeamParameters(teamId, {
                        participantId: state.user.id,
                        paramId: param.id,
                        value: newValue
                    });
                    const budgetUsed = calculateBudgetUsed(candidateAgg);
                    const budgetTotal = state.session.budgetTotal;

                    if (budgetUsed > budgetTotal) {
                        // Откат (нельзя выйти за бюджет)
                        if (pRow) pRow.value = prevValue;
                        e.target.value = String(prevValue);
                        card.querySelector(`#value-${param.id}`).textContent = prevValue + param.unit;
                        showNotification(`Недостаточно бюджета: ${budgetUsed} / ${budgetTotal}. Откат изменения.`, 'error');
                        recomputeTeamAggregate(teamId);
                        updateIGSDisplay();
                        updateConfirmButton();
                        return;
                    }

                    card.querySelector(`#value-${param.id}`).textContent = newValue + param.unit;

                    // Пересчёт агрегации команды и UI
                    recomputeTeamAggregate(teamId);
                    debounceSaveDecision(state.user.id);
                    updateIGSDisplay();
                    updateConfirmButton();
                });
            }
        });
    });
    
    // Добавляем панель ИГС
    renderIGSPanel();
    updateConfirmButton();
}

// Отображение панели ИГС для участника
function renderIGSPanel() {
    let igsPanel = $('#igs-panel');
    
    // Создаём панель если её нет
    if (!igsPanel) {
        igsPanel = document.createElement('div');
        igsPanel.id = 'igs-panel';
        igsPanel.className = 'igs-panel';
        const paramsSection = $('#parameters-grid');
        if (paramsSection && paramsSection.parentNode) {
            paramsSection.parentNode.insertBefore(igsPanel, paramsSection);
        }
    }
    
    const teamData = state.user.team ? getTeamData(state.user.team.id) : null;
    if (!teamData || !igsPanel) return;
    
    const igs = calculateIGS(teamData.parameters);
    
    igsPanel.innerHTML = `
        <div class="igs-main">
            <div class="igs-label">ИГС вашей команды</div>
            <div class="igs-value ${getIGSClass(igs.total)}">${igs.total.toFixed(1)}</div>
            <div class="igs-bar">
                <div class="igs-bar-fill" style="width: ${igs.total}%"></div>
            </div>
        </div>
        <div class="igs-components">
            ${CONFIG.parameterCategories.map(cat => {
                const val = igs.components[cat.id];
                const contribution = cat.weight * val;
                return `
                    <div class="igs-component" title="${cat.name}: ${val.toFixed(1)} × ${cat.weight} = ${contribution.toFixed(1)}">
                        <span class="comp-icon">${cat.icon}</span>
                        <span class="comp-value" style="color: ${cat.color}">${val.toFixed(0)}</span>
                    </div>
                `;
            }).join('')}
            <div class="igs-component conflict" title="Конфликт интересов: ${igs.components.D.toFixed(1)}">
                <span class="comp-icon">⚡</span>
                <span class="comp-value">${igs.components.D.toFixed(0)}</span>
            </div>
        </div>
    `;
}

function getIGSClass(value) {
    if (value >= 70) return 'igs-high';
    if (value >= 40) return 'igs-mid';
    return 'igs-low';
}

// Расчёт использованного бюджета
function calculateBudgetUsed(parameters) {
    let cost = 0;
    const allParams = getAllParameters();
    
    parameters.forEach(p => {
        const paramDef = allParams.find(def => def.id === p.id);
        if (paramDef) {
            const delta = p.value - paramDef.default;
            // Бюджет должен "расходоваться" при изменениях, поэтому стоимость всегда положительная.
            // (Если когда-то нужно будет "экономию", это лучше делать отдельной механикой, а не отрицательной стоимостью.)
            const rawCost = CONFIG.parameterCosts[p.id] ?? 10;
            const paramCost = Math.abs(rawCost);
            cost += Math.abs(delta) * paramCost / 10;
        }
    });
    
    return Math.max(0, Math.round(cost));
}

// Обновление Hero-дисплея ИГС (как в En-ROADS)
function updateIGSHero() {
    const heroValue = $('#igs-hero-value');
    const heroFill = $('#igs-hero-fill');
    const budgetDisplay = $('#budget-display');
    const igsHero = $('#igs-hero');
    
    if (!heroValue) return;
    
    const teamData = state.user.team ? getTeamData(state.user.team.id) : null;
    if (!teamData) return;
    
    const igs = calculateIGS(teamData.parameters);
    // Бюджет — реальная стоимость изменения параметров относительно дефолта
    const budgetUsed = calculateBudgetUsed(teamData.parameters);
    const budgetTotal = state.session.budgetTotal;
    
    heroValue.textContent = igs.total.toFixed(1);
    heroFill.style.width = `${igs.total}%`;
    
    // Класс цвета
    heroValue.className = 'igs-number ' + getIGSClass(igs.total);
    
    // Бюджет
    if (budgetDisplay) {
        budgetDisplay.textContent = `${budgetUsed} / ${budgetTotal}`;
        if (budgetUsed > budgetTotal) {
            budgetDisplay.classList.add('over');
        } else {
            budgetDisplay.classList.remove('over');
        }
    }
}

function updateIGSDisplay() {
    renderIGSPanel();
    updateIGSHero();
    updateTerritoryMap();
}

// =====================================================
// ИНТЕРАКТИВНАЯ КАРТА ТЕРРИТОРИИ
// =====================================================

function updateTerritoryMap() {
    const mapSvg = $('#map-svg');
    if (!mapSvg) return;
    
    const teamData = state.user.team ? getTeamData(state.user.team.id) : null;
    if (!teamData) return;
    
    // Получаем значения ключевых параметров
    const getParamValue = (id) => {
        const param = teamData.parameters.find(p => p.id === id);
        return param ? param.value : 50;
    };
    
    const greenZones = getParamValue('Z');   // Доля зелёных зон
    const traffic = getParamValue('Tp');     // Трафик
    const hardCover = getParamValue('Ca');   // Твёрдое покрытие
    const lighting = getParamValue('O');     // Освещённость
    const bikePaths = getParamValue('B');    // Велоинфраструктура
    const igsTotal = calculateIGS(teamData.parameters).total;
    
    // Обновляем визуализацию карты
    
    // Зелёные зоны — меняем РАЗМЕР (мягко) вместо прозрачности.
    // Привязываем к итоговому ИГС: при высоком ИГС "озеленение" заполняет поле.
    const greenElements = mapSvg.querySelectorAll('.zone');
    greenElements.forEach(el => {
        const scale = Math.max(0.55, Math.min(3.0, 0.55 + (igsTotal / 100) * 2.45));
        el.style.transform = `scale(${scale})`;
    });
    mapSvg.classList.toggle('igs-max', igsTotal >= 95);
    
    // Дороги — меняем цвет по трафику
    const roadElements = mapSvg.querySelectorAll('.road');
    roadElements.forEach(el => {
        const red = Math.round(55 + (traffic / 100) * 100);
        const green = Math.round(65 - (traffic / 100) * 40);
        el.style.fill = `rgb(${red}, ${green}, 81)`;
    });
    
    // Пешеходные дорожки — видимость по велоинфраструктуре
    const pathElements = mapSvg.querySelectorAll('.map-paths path');
    pathElements.forEach(el => {
        el.style.opacity = 0.3 + (bikePaths / 100) * 0.5;
        el.style.strokeWidth = 2 + (bikePaths / 100) * 3;
    });
    
    // Обновляем статистику
    const statGreen = $('#stat-green');
    const statBuildings = $('#stat-buildings');
    const statRoads = $('#stat-roads');
    
    if (statGreen) statGreen.textContent = greenZones + '%';
    if (statBuildings) statBuildings.textContent = Math.round(100 - greenZones - hardCover * 0.3) + '%';
    if (statRoads) statRoads.textContent = Math.round(hardCover * 0.4) + '%';
    
    // Добавляем классы для стилизации
    mapSvg.classList.toggle('high-green', greenZones > 60);
    mapSvg.classList.toggle('low-green', greenZones < 30);
    mapSvg.classList.toggle('high-traffic', traffic > 60);
    mapSvg.classList.toggle('low-traffic', traffic < 30);
}

function initTerritoryMapControls() {
    const toggleBtn = $('#toggle-map');
    const mapContainer = $('#territory-map');
    
    if (toggleBtn && mapContainer) {
        toggleBtn.addEventListener('click', () => {
            mapContainer.classList.toggle('collapsed');
            toggleBtn.textContent = mapContainer.classList.contains('collapsed') ? 'Развернуть' : 'Свернуть';
        });
    }
    
    // Клики по элементам карты
    const mapSvg = $('#map-svg');
    if (mapSvg) {
        mapSvg.querySelectorAll('.poi').forEach(poi => {
            poi.addEventListener('click', (e) => {
                const type = e.target.dataset.type;
                showMapPOIInfo(type);
            });
        });
    }
}

function showMapPOIInfo(type) {
    const info = {
        playground: { name: 'Детская площадка', icon: '🎠', desc: 'Зона для детей 3-12 лет' },
        bench: { name: 'Зона отдыха', icon: '🪑', desc: 'Скамейки и место для отдыха' },
        shop: { name: 'Торговая точка', icon: '🏪', desc: 'Малый бизнес' },
        transit: { name: 'Остановка ОТ', icon: '🚌', desc: 'Общественный транспорт' }
    };
    
    const poiInfo = info[type];
    if (poiInfo) {
        showNotification(`${poiInfo.icon} ${poiInfo.name}: ${poiInfo.desc}`, 'info');
    }
}

function updateConfirmButton() {
    const btn = $('#confirm-btn');
    const statusEl = $('#confirm-status');
    if (!btn || !statusEl) return;
    
    const currentPhase = state.session.phase;
    
    // Проверяем, активна ли фаза ввода (1 или 4)
    const isInputPhase = (currentPhase === 1 || currentPhase === 4);
    
    if (!isInputPhase) {
        btn.disabled = true;
        statusEl.textContent = getPhaseStatusMessage(currentPhase);
        return;
    }

    const isConfirmed = isParticipantConfirmedForPhase(state.user.id, currentPhase);
    if (isConfirmed) {
        btn.disabled = true;
        statusEl.textContent = 'Вы подтвердили своё решение ✓';
        return;
    }

    btn.disabled = false;
    const teamId = state.user?.team?.id;
    if (teamId) {
        const prog = getTeamDecisionProgress(teamId, currentPhase);
        statusEl.textContent = `Подтвердите ваше решение. Подтвердили в команде: ${prog.confirmed}/${prog.total}`;
    } else {
        statusEl.textContent = 'Подтвердите ваше решение';
    }
}

function confirmDecision() {
    const currentPhase = Number(state.session.phase);
    const isInputPhase = (currentPhase === 1 || currentPhase === 4);
    if (!isInputPhase) {
        showNotification('Подтверждение доступно только в фазах 1 и 4', 'warning');
        return;
    }

    const teamId = state.user?.team?.id || null;
    const decision = ensureParticipantDecision(state.user.id, teamId);
    decision.confirmed = true;
    decision.confirmedPhase = currentPhase;
    saveParticipantDecision(state.user.id);

    recomputeAllTeamAggregates();

    $('#confirm-status').textContent = 'Вы подтвердили своё решение ✓';
    $('#confirm-btn').disabled = true;
    
    // После подтверждения блокируем ползунки (до смены фазы)
    renderParameters();
    
    addToHistory(`Подтвердили своё решение (${state.user.team?.name || 'команда'})`);
    addToLog('confirm', `${state.user.name} подтвердил(а) решение в фазе ${currentPhase} (${state.user.team?.name || '-'})`);
    showNotification('Ваше решение отправлено!', 'success');
    updateConfirmButton();
}

// Панель истории
function initHistoryPanel() {
    $('#p-history-toggle').addEventListener('click', () => {
        $('#history-panel').classList.add('open');
    });
    
    $('#history-close').addEventListener('click', () => {
        $('#history-panel').classList.remove('open');
    });
}

function addToHistory(action) {
    const entry = {
        time: new Date(),
        action: action
    };
    state.history.unshift(entry);
    renderHistory();
}

function renderHistory() {
    const list = $('#history-list');
    list.innerHTML = state.history.map(entry => `
        <div class="history-item">
            <div class="time">${formatTime(entry.time)}</div>
            <div class="action">${entry.action}</div>
        </div>
    `).join('');
}

// =====================================================
// ЭКРАН МОДЕРАТОРА
// =====================================================

function initModeratorScreen() {
    // Важно: модераторский UI должен отрисовываться даже если какой-то блок не инициализировался
    // (например, в старой версии index.html нет части кнопок).
    try { updateModeratorHeader(); } catch (e) { console.error('❌ updateModeratorHeader failed', e); }
    try { initModeratorTabs(); } catch (e) { console.error('❌ initModeratorTabs failed', e); }
    try { initPhaseControls(); } catch (e) { console.error('❌ initPhaseControls failed', e); }
    try { initEventEditor(); } catch (e) { console.error('❌ initEventEditor failed', e); }
    try { initModeratorActions(); } catch (e) { console.error('❌ initModeratorActions failed', e); }
    try { initExportModal(); } catch (e) { console.error('❌ initExportModal failed', e); }
    
    // Гарантируем, что видна матрица по умолчанию
    try {
        $$('.mod-tab').forEach(t => t.classList.remove('active'));
        $$('.mod-panel').forEach(p => p.classList.remove('active'));
        const matrixTab = document.querySelector('.mod-tab[data-panel="matrix"]');
        const matrixPanel = $('#panel-matrix');
        if (matrixTab) matrixTab.classList.add('active');
        if (matrixPanel) matrixPanel.classList.add('active');
    } catch (_) {}
    
    // Рендер — всегда
    try { renderParticipantsList(); } catch (e) { console.error('❌ renderParticipantsList failed', e); }
    try { renderParamsMatrix(); } catch (e) { console.error('❌ renderParamsMatrix failed', e); }
    try { renderAvgParams(); } catch (e) { console.error('❌ renderAvgParams failed', e); }
    try { initCharts(); } catch (e) { console.error('❌ initCharts failed', e); }

    // Подстраховка: прокрутить к матрице, если пользователь "видит только участников"
    setTimeout(() => {
        const panel = $('#panel-matrix');
        if (panel?.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);
}

function updateModeratorHeader() {
    $('#m-session-code').textContent = state.session.code;
    $('#m-session-name').textContent = state.session.name;
    $('#m-phase').textContent = state.session.phase;
    $('#m-phase-title').textContent = CONFIG.phases[state.session.phase]?.name || '';
}

function updateModeratorUI() {
    renderParticipantsList();
    renderParamsMatrix();
    renderAvgParams();
    updateMetrics();
    updateCharts();
}

// Табы модератора
function initModeratorTabs() {
    $$('.mod-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            $$('.mod-tab').forEach(t => t.classList.remove('active'));
            $$('.mod-panel').forEach(p => p.classList.remove('active'));
            
            tab.classList.add('active');
            $(`#panel-${tab.dataset.panel}`).classList.add('active');
        });
    });
}

// Управление фазами (только вперёд!)
function initPhaseControls() {
    onId('next-phase', 'click', () => {
        if (state.session.phase < CONFIG.phases.length - 1) {
            const oldPhase = state.session.phase;
            state.session.phase++;
            
            console.log(`🎮 Модератор: переход фазы ${oldPhase} → ${state.session.phase}`);
            
            // Обновляем UI модератора
            updatePhaseUI();
            
            // Сохраняем в Firebase (это обновит состояние сессии)
            saveSessionToFirebase();
            
            // Синхронизируем фазу с Firebase для участников
            updatePhaseInFirebase(state.session.phase);
            
            // Лог
            const phaseName = CONFIG.phases[state.session.phase].name;
            addToLog('phase', `▶ Фаза ${state.session.phase}: ${phaseName}`);
            showNotification(`Фаза ${state.session.phase}: ${phaseName}`, 'success');
            
            // Если последняя фаза — скрываем кнопку
            if (state.session.phase >= CONFIG.phases.length - 1) {
                $('#next-phase').disabled = true;
                $('#next-phase').textContent = '🏁 Игра завершена';
            }
        }
    });
    
    onId('pause-btn', 'click', () => {
        state.session.isPaused = !state.session.isPaused;
        const btn = $('#pause-btn');
        if (!btn) return;
        
        if (state.session.isPaused) {
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="5,3 19,12 5,21"/>
                </svg>
                <span>Продолжить</span>
            `;
            btn.classList.remove('btn-warning');
            btn.classList.add('btn-primary');
            addToLog('system', 'Симуляция приостановлена');
        } else {
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="6" y="4" width="4" height="16"/>
                    <rect x="14" y="4" width="4" height="16"/>
                </svg>
                <span>Пауза</span>
            `;
            btn.classList.add('btn-warning');
            btn.classList.remove('btn-primary');
            addToLog('system', 'Симуляция возобновлена');
        }
    });
}

function updatePhaseUI() {
    const phase = state.session.phase;
    const phaseConfig = CONFIG.phases[phase];
    
    console.log(`🎯 updatePhaseUI: обновление UI для фазы ${phase}`);
    
    // Модератор UI
    const phaseNumber = $('#m-phase');
    const phaseTitle = $('#m-phase-title');
    const phaseIndicator = document.querySelector('.moderator-header .phase-indicator');
    
    if (phaseNumber) phaseNumber.textContent = phase;
    if (phaseTitle) phaseTitle.textContent = phaseConfig?.name || '';
    
    // Анимация смены фазы
    if (phaseIndicator) {
        phaseIndicator.classList.add('phase-changing');
        setTimeout(() => phaseIndicator.classList.remove('phase-changing'), 500);
    }
    
    // Участник UI — баннер фазы
    const phaseBanner = $('#phase-banner');
    if (phaseBanner) {
        const bannerNumber = phaseBanner.querySelector('.phase-banner-number');
        const bannerTitle = phaseBanner.querySelector('.phase-banner-title');
        const bannerDesc = phaseBanner.querySelector('.phase-banner-desc');
        
        if (bannerNumber) bannerNumber.textContent = `ФАЗА ${phase}`;
        if (bannerTitle) bannerTitle.textContent = phaseConfig?.name || '';
        if (bannerDesc) bannerDesc.textContent = phaseConfig?.desc || '';
        
        // Показываем баннер на 4 секунды
        phaseBanner.classList.add('visible');
        setTimeout(() => phaseBanner.classList.remove('visible'), 4000);
    }
    
    // Обновляем хедер участника
    const pPhase = $('#p-phase');
    const pPhaseTitle = $('#p-phase-title');
    if (pPhase) pPhase.textContent = phase;
    if (pPhaseTitle) pPhaseTitle.textContent = phaseConfig?.name || '';
    
    // Применяем логику фаз
    applyPhaseLogic(phase);

    // Для участника всегда обновляем баннер события + статус кнопки
    // (это исправляет кейс, когда фазу обновил общий listener, а phase-listener не сработал из-за гонки)
    if (!state.user.isModerator) {
        updateEventBanner(phase);
        updateConfirmButton();
    }

    // Экран завершения игры
    if (phase === 5) {
        showEndgameOverlay();
    }
    
    // Логируем
    console.log(`📍 Фаза ${phase}: ${phaseConfig?.name} — ${phaseConfig?.desc}`);
}

function initEndgameOverlay() {
    const closeBtn = $('#endgame-close');
    if (closeBtn) closeBtn.addEventListener('click', hideEndgameOverlay);

    const pdfBtn = $('#endgame-export-pdf');
    if (pdfBtn) pdfBtn.addEventListener('click', () => {
        exportData('pdf');
    });

    const htmlBtn = $('#endgame-export-html');
    if (htmlBtn) htmlBtn.addEventListener('click', () => {
        exportProtocolHTML();
    });
}

function hideEndgameOverlay() {
    const overlay = $('#endgame-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function showEndgameOverlay() {
    const overlay = $('#endgame-overlay');
    const valueEl = $('#endgame-igs-value');
    const sparklineEl = $('#endgame-sparkline');
    if (!overlay || !valueEl || !sparklineEl) return;
    
    // Итоговый консенсус
    const avg = calculateAverageIGS();
    const target = avg ? avg.total : (state.user.team ? calculateTeamIGS(state.user.team.id).total : 0);
    
    overlay.classList.remove('hidden');
    
    // Анимация числа
    const start = Number(valueEl.textContent) || 0;
    const duration = 1400;
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    
    const step = (now) => {
        const t = Math.min(1, (now - t0) / duration);
        const v = start + (target - start) * ease(t);
        valueEl.textContent = v.toFixed(1);
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    
    // Спарклайн по динамике консенсуса
    const points = (state.timelineData || [])
        .filter(d => typeof d.consensusIGS === 'number')
        .map(d => d.consensusIGS);
    const series = points.length >= 2 ? points : [start, target];
    
    const w = 540;
    const h = 90;
    const pad = 10;
    const minV = Math.min(...series, 0);
    const maxV = Math.max(...series, 100);
    const xStep = (w - pad * 2) / Math.max(1, series.length - 1);
    const y = (val) => {
        const t = (val - minV) / Math.max(1e-6, (maxV - minV));
        return (h - pad) - t * (h - pad * 2);
    };
    
    const d = series.map((v, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * xStep} ${y(v).toFixed(2)}`).join(' ');
    
    sparklineEl.innerHTML = `
        <svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="none">
            <defs>
                <linearGradient id="endgameGrad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#ef4444"/>
                    <stop offset="50%" stop-color="#f59e0b"/>
                    <stop offset="100%" stop-color="#10b981"/>
                </linearGradient>
            </defs>
            <path d="${d}" fill="none" stroke="url(#endgameGrad)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;
}

// Логика блокировок и действий по фазам
function applyPhaseLogic(phase) {
    // Фазы 1 и 4 — ползунки активны (Раунд 1 и Раунд 2)
    const isInputPhase = (phase === 1 || phase === 4);
    
    console.log(`⚙️ Применяю логику фазы ${phase}, ввод активен: ${isInputPhase}`);
    
    // Блокируем/разблокируем ползунки (только для участников)
    if (!state.user.isModerator) {
        const sliders = $$('.param-card .slider');
        sliders.forEach(slider => {
            // конкретные блокировки/подтверждение учтём в renderParameters(),
            // здесь — только "фаза ввода или нет"
            slider.disabled = !isInputPhase;
        });
        
        // Визуально показываем статус ползунков
        $$('.param-card').forEach(card => {
            card.classList.toggle('phase-locked', !isInputPhase);
        });
        
        // Кнопка подтверждения
        const confirmBtn = $('#confirm-btn');
        if (confirmBtn) {
            confirmBtn.style.display = isInputPhase ? 'block' : 'none';
        }
        
        // Обновляем сообщение о статусе фазы
        const confirmStatus = $('#confirm-status');
        if (confirmStatus) {
            confirmStatus.textContent = getPhaseStatusMessage(phase);
        }
    }
    
    // Сохраняем снимок после раунда 1 (только модератор)
    if (state.user.isModerator && phase === 2 && !state.session.round1Snapshot) {
        state.session.round1Snapshot = JSON.parse(JSON.stringify(state.teamsData));
        addToLog('system', 'Снимок после Раунда 1 сохранён');
    }
}

function getPhaseStatusMessage(phase) {
    switch(phase) {
        case 0: return '⏳ Ожидание начала игры...';
        case 1: return '✏️ Раунд 1: Внесите ваши предложения';
        case 2: return '📊 Анализ: Изучите результаты команд';
        case 3: return '⚡ Интермиссия: Ожидайте событие от модератора';
        case 4: return '🤝 Раунд 2: Скорректируйте решения';
        case 5: return '🏁 Итоги: Игра завершена';
        default: return '';
    }
}

// Обновление баннера события для участника
function updateEventBanner(phase) {
    const eventTitle = $('#event-title');
    const eventText = $('#event-text');
    const eventIcon = document.querySelector('#event-banner .event-icon');
    
    if (!eventTitle || !eventText) return;
    
    const phaseInfo = {
        0: { icon: '⏳', title: 'Добро пожаловать!', text: 'Ожидайте начала симуляции от модератора.' },
        1: { icon: '✏️', title: 'Раунд 1: Принятие решений', text: 'Обсудите в команде и настройте параметры проекта. Решение команды — среднее по участникам.' },
        2: { icon: '📊', title: 'Анализ результатов', text: 'Изучите решения других команд. Обсудите конфликты и точки согласия.' },
        3: { icon: '⚡', title: 'Интермиссия', text: 'Модератор вводит неожиданное событие. Готовьтесь к изменениям!' },
        4: { icon: '🤝', title: 'Раунд 2: Переговоры', text: 'Скорректируйте решения с учётом новых условий и мнений других команд. Решение команды — среднее по участникам.' },
        5: { icon: '🏁', title: 'Игра завершена!', text: 'Спасибо за участие! Ознакомьтесь с итоговыми результатами.' }
    };
    
    const info = phaseInfo[phase] || phaseInfo[0];
    
    if (eventIcon) eventIcon.textContent = info.icon;
    eventTitle.textContent = info.title;
    eventText.textContent = info.text;
}

// Список участников — СГРУППИРОВАНО ПО КОМАНДАМ
function renderParticipantsList() {
    const list = $('#participants-list');
    const count = $('#participants-count');
    
    count.textContent = state.participants.length;
    
    if (state.participants.length === 0) {
        list.innerHTML = '<div class="empty-state">Нет участников</div>';
        return;
    }
    
    const activeTeams = getTeamsForAnalytics();
    
    let html = '';
    activeTeams.forEach(team => {
        const teamMembers = getTeamMembers(team.id);
        const teamData = getTeamData(team.id);
        const phase = Number(state.session.phase);
        const isInputPhase = (phase === 1 || phase === 4);
        const prog = getTeamDecisionProgress(team.id, phase);
        const progText = isInputPhase && prog.total > 0 ? ` · ${prog.confirmed}/${prog.total}` : '';
        const doneMark = (isInputPhase && prog.total > 0 && prog.confirmed === prog.total) ? '✓' : '';
        
        html += `<div class="team-group" style="border-left: 3px solid ${team.color}; margin-bottom: 1rem; padding-left: 0.75rem;">`;
        html += `<div class="team-group-header" style="font-size: 0.75rem; font-weight: 600; color: ${team.color}; margin-bottom: 0.5rem;">
            ${team.name} (${teamMembers.length}) ${doneMark}${progText}
        </div>`;
        
        teamMembers.forEach(p => {
            const isCaptainMember = p.id === teamData.captainId;
            const captainBadge = isCaptainMember ? '👑' : '';
            const roleBadge = p.gameRole ? `<span class="participant-role">${p.gameRole.icon}</span>` : '';
            
            html += `
                <div class="participant-item" data-id="${p.id}">
                    <div class="participant-avatar ${p.isBot ? 'bot' : ''}" style="border-color: ${team.color}">${getInitials(p.name)}</div>
                    <div class="participant-info">
                        <div class="participant-name">${captainBadge} ${roleBadge} ${p.name} ${p.isBot ? '🤖' : ''}</div>
                        <div class="participant-status">
                            ${isCaptainMember ? 'Капитан' : 'Участник'}
                        </div>
                    </div>
                </div>
            `;
        });
        
        html += '</div>';
    });
    
    list.innerHTML = html;
}

function addParticipant(name, isBot = false, values = null, realRole = null) {
    // Если роль не указана, выбираем случайную
    const roleKeys = Object.keys(CONFIG.realRoles);
    const assignedRealRole = realRole || roleKeys[Math.floor(Math.random() * roleKeys.length)];
    
    // Игровая роль отличается от реальной
    const availableGameRoles = CONFIG.gameRoles.filter(r => r.id !== assignedRealRole);
    
    // Выбираем игровую роль так, чтобы команды были более-менее сбалансированы
    const roleCandidates = availableGameRoles
        .map(role => {
            const teamId = CONFIG.teamByGameRole?.[role.id] || null;
            const count = teamId ? state.participants.filter(p => getParticipantTeamId(p) === teamId).length : Number.MAX_SAFE_INTEGER;
            return { role, teamId, count };
        })
        .filter(x => x.teamId);
    roleCandidates.sort((a, b) => a.count - b.count);
    
    const chosen = roleCandidates.length > 0
        ? roleCandidates[0]
        : { role: availableGameRoles[Math.floor(Math.random() * availableGameRoles.length)], teamId: null, count: 0 };
    
    const assignedGameRole = chosen.role;
    const assignedTeam = (chosen.teamId ? CONFIG.teams.find(t => t.id === chosen.teamId) : null) || CONFIG.teams[0];
    
    // Инициализируем данные команды, если нужно
    initTeamData(assignedTeam.id);
    
    const participant = {
        id: generateId(),
        name: name,
        isBot: isBot,
        realRole: assignedRealRole,
        gameRole: assignedGameRole,
        team: assignedTeam,
        isCaptain: false
    };
    
    state.participants.push(participant);

    // Решение участника: если переданы values (пресет), используем их; иначе — дефолты
    const decision = ensureParticipantDecision(participant.id, assignedTeam.id);
    if (values && typeof values === 'object') {
        try {
            // values может быть вида {Z: 10, ...} — подставим в parameters
            const all = createDefaultParametersArray();
            decision.parameters = all.map(p => ({
                id: p.id,
                value: (values[p.id] !== undefined) ? Number(values[p.id]) : p.value
            }));
        } catch (_) {}
    }
    decision.confirmed = false;
    decision.confirmedPhase = null;
    decision.updatedAt = new Date().toISOString();
    
    // Назначаем капитана команды
    assignTeamCaptain(assignedTeam.id);
    
    renderParticipantsList();
    renderParamsMatrix();
    updateMetrics();
    
    const captainLabel = participant.isCaptain ? ' (капитан)' : '';
    addToLog('join', `${name}${isBot ? ' (бот)' : ''}${captainLabel} → ${assignedTeam.name}, роль: ${assignedGameRole.name}`);
    
    if (!isBot) {
        showNotification(`${name} присоединился к ${assignedTeam.name}`, 'info');
    }
}

// Матрица параметров — ПО КОМАНДАМ с ИГС
function renderParamsMatrix() {
    const matrix = $('#params-matrix');
    if (!matrix) return;
    const activeTeams = getTeamsForAnalytics();
    
    if (activeTeams.length === 0) {
        // Если участники есть, но команд нет — значит у участников не назначены команды (данные битые)
        if (state.participants.length > 0) {
            matrix.innerHTML = '<tr><td colspan="100%" style="text-align: center; padding: 2rem;">Участники есть, но команды не определены (проверьте, что у участника есть поле team.id)</td></tr>';
        } else {
            matrix.innerHTML = '<tr><td colspan="100%" style="text-align: center; padding: 2rem;">Нет активных команд</td></tr>';
        }
        return;
    }
    
    // Заголовки: категории параметров
    let html = '<thead><tr><th>Команда</th>';
    CONFIG.parameterCategories.forEach(cat => {
        html += `<th style="color: ${cat.color}" title="${cat.name}">${cat.icon}</th>`;
    });
    html += '<th title="Индекс Городской Среды">ИГС</th><th>Статус</th></tr></thead><tbody>';
    
    activeTeams.forEach(team => {
        const teamData = getTeamData(team.id);
        const teamMembers = getTeamMembers(team.id);
        const captain = teamMembers.find(m => m.id === teamData.captainId);
        const igs = calculateIGS(teamData.parameters);
        
        // Роли команды (по реальным ролям участников)
        const roleIcons = [...new Set(teamMembers.map(m => CONFIG.realRoles[m.realRole]?.icon).filter(Boolean))].join(' ');
        
        html += `<tr style="border-left: 4px solid ${team.color}">`;
        html += `<td class="participant-name-cell">
            <div><strong>${team.name}</strong></div>
            <div style="font-size: 0.75rem; color: var(--text-muted)">
                ${teamMembers.length} уч. | 👑 ${captain?.name || '—'}${roleIcons ? ` | ${roleIcons}` : ''}
            </div>
        </td>`;
        
        // Показываем значение каждой категории
        CONFIG.parameterCategories.forEach(cat => {
            const catValue = igs.components[cat.id];
            const colorClass = catValue <= 33 ? 'low' : (catValue <= 66 ? 'mid' : 'high');
            html += `<td class="${colorClass}" title="${cat.name}: ${catValue.toFixed(1)}">${catValue.toFixed(0)}</td>`;
        });
        
        // ИГС
        const igsClass = getIGSClass(igs.total);
        html += `<td class="${igsClass}" style="font-weight: bold">${igs.total.toFixed(1)}</td>`;
        
        const statusClass = teamData.confirmed ? 'confirmed' : '';
        const statusText = teamData.confirmed ? '✓' : '○';
        html += `<td class="${statusClass}">${statusText}</td>`;
        
        html += '</tr>';
    });
    
    // Строка консенсуса (среднее)
    const avgIGS = calculateAverageIGS();
    if (avgIGS) {
        html += `<tr class="consensus-row">`;
        html += `<td class="participant-name-cell"><strong>📊 Консенсус</strong></td>`;
        
        CONFIG.parameterCategories.forEach(cat => {
            const catValue = avgIGS.components[cat.id];
            html += `<td>${catValue.toFixed(0)}</td>`;
        });
        
        html += `<td style="font-weight: bold; color: var(--accent)">${avgIGS.total.toFixed(1)}</td>`;
        html += `<td>—</td>`;
        html += '</tr>';
        
        // Строка конфликта
        const conflict = calculateConflict();
        html += `<tr class="conflict-row">`;
        html += `<td class="participant-name-cell"><span style="color: var(--danger)">⚡ Конфликт (D)</span></td>`;
        html += `<td colspan="${CONFIG.parameterCategories.length}"></td>`;
        html += `<td style="color: var(--danger)">${conflict.toFixed(1)}</td>`;
        html += `<td>−${(0.10 * conflict).toFixed(1)}</td>`;
        html += '</tr>';
    }
    
    html += '</tbody>';
    matrix.innerHTML = html;
}

// Средние параметры и ИГС — ПО КОМАНДАМ
function renderAvgParams() {
    const container = $('#avg-params');
    const activeTeams = getTeamsForAnalytics();
    
    if (activeTeams.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет данных</div>';
        return;
    }
    
    const avgIGS = calculateAverageIGS();
    const conflict = calculateConflict();
    
    if (!avgIGS) {
        container.innerHTML = '<div class="empty-state">Нет данных</div>';
        return;
    }
    
    let html = `
        <div class="avg-igs-display">
            <div class="avg-igs-main">
                <div class="avg-igs-label">Консенсус ИГС</div>
                <div class="avg-igs-value ${getIGSClass(avgIGS.total)}">${avgIGS.total.toFixed(1)}</div>
            </div>
            <div class="avg-igs-conflict">
                <span>⚡ Конфликт:</span>
                <span style="color: var(--danger)">${conflict.toFixed(1)}</span>
            </div>
        </div>
        <div class="avg-components">
    `;
    
    CONFIG.parameterCategories.forEach(cat => {
        const val = avgIGS.components[cat.id];
        html += `
            <div class="avg-param">
                <span class="avg-param-name">${cat.icon} ${cat.name}</span>
                <span class="avg-param-value" style="color: ${cat.color}">${val.toFixed(0)}</span>
            </div>
        `;
    });
    
    html += '</div>';
    container.innerHTML = html;
}

// Метрики — ПО КОМАНДАМ с ИГС
function updateMetrics() {
    const activeTeams = getTeamsForAnalytics();
    
    if (activeTeams.length < 1) {
        $('#metric-d').textContent = '—';
        $('#metric-s').textContent = '—';
        $('#consensus-value').textContent = '—';
        $('#consensus-fill').style.width = '0%';
        return;
    }
    
    // Показатель D (конфликт интересов)
    const D = calculateConflict();
    $('#metric-d').textContent = D.toFixed(1);
    
    // Показатель S (синхронизация) - % подтвердивших команд
    const confirmedTeams = activeTeams.filter(team => getTeamData(team.id).confirmed).length;
    const S = activeTeams.length > 0 ? Math.round((confirmedTeams / activeTeams.length) * 100) : 0;
    $('#metric-s').textContent = `${S}%`;
    
    // ИГС консенсуса
    const avgIGS = calculateAverageIGS();
    const igsValue = avgIGS ? avgIGS.total : 0;
    $('#consensus-value').textContent = igsValue.toFixed(1);
    $('#consensus-fill').style.width = `${igsValue}%`;
}

// Редактор событий
function initEventEditor() {
    // Шаблоны событий
    $$('.template-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const template = CONFIG.eventTemplates[btn.dataset.template];
            if (template) {
                const nameInput = $('#event-name-input');
                const descInput = $('#event-desc-input');
                const effectSelect = $('#event-effect-select');
                if (nameInput) nameInput.value = template.name;
                if (descInput) descInput.value = template.desc;
                if (effectSelect) effectSelect.value = template.effect;
                updateEffectParams(template.effect, template.params);
            }
        });
    });
    
    // Изменение эффекта
    onId('event-effect-select', 'change', (e) => {
        updateEffectParams(e?.target?.value);
    });
    
    // Отправка события
    onId('send-event-btn', 'click', sendEvent);
}

function updateEffectParams(effect, defaultParams = {}) {
    const container = $('#effect-params');
    if (!container) return;
    
    if (effect === 'none' || effect === 'lock_all') {
        container.innerHTML = '';
        return;
    }
    
    let html = '';
    
    if (['limit_max', 'limit_min', 'lock', 'force'].includes(effect)) {
        html += `
            <div class="input-group">
                <label>Параметр</label>
                <select id="effect-parameter">
                    ${state.parameters.map(p => `
                        <option value="${p.id}" ${defaultParams.parameter === p.id ? 'selected' : ''}>${p.name}</option>
                    `).join('')}
                </select>
            </div>
        `;
    }
    
    if (['limit_max', 'limit_min', 'force'].includes(effect)) {
        html += `
            <div class="input-group">
                <label>Значение</label>
                <input type="number" id="effect-value" min="0" max="100" value="${defaultParams.value || 50}">
            </div>
        `;
    }
    
    container.innerHTML = html;
}

function sendEvent() {
    const name = $('#event-name-input')?.value?.trim?.() || '';
    const desc = $('#event-desc-input')?.value?.trim?.() || '';
    const effect = $('#event-effect-select')?.value || 'none';
    
    if (!name || !desc) {
        showNotification('Заполните название и описание события', 'error');
        return;
    }
    
    const event = {
        id: generateId(),
        name,
        desc,
        effect,
        params: {},
        time: new Date().toISOString(),
        phase: state.session.phase,
        from: state.user?.name || 'Модератор'
    };
    
    // Получаем параметры эффекта
    const paramSelect = $('#effect-parameter');
    const valueInput = $('#effect-value');
    
    if (paramSelect) event.params.parameter = paramSelect.value;
    if (valueInput) event.params.value = parseInt(valueInput.value);
    
    // Модератору не применяем эффект локально — иначе он может случайно "залочить" себе UI.
    // Эффект применяют участники при получении события.

    // Отправляем событие участникам (Firebase / local)
    console.log('📣 sendEvent: отправляю событие участникам', {
        code: state.session.code,
        phase: state.session.phase,
        effect: event.effect,
        params: event.params
    });
    if (!state.session.code) {
        console.warn('⚠️ sendEvent: нет кода сессии');
        showNotification('Нет кода сессии — событие не отправлено', 'error');
    } else if (!firebaseEnabled) {
        localBroadcast({ type: 'event', code: state.session.code, event });
    } else {
        try {
            firebaseDB.ref(`sessions/${state.session.code}/events`).push().set(event).then(() => {
                console.log('✅ sendEvent: событие записано в Firebase');
            }).catch((e) => {
                console.error('❌ Ошибка отправки события в Firebase:', e);
                const msg = isFirebasePermissionDenied(e)
                    ? 'Не удалось отправить событие: Firebase Rules запрещают запись (PERMISSION_DENIED).'
                    : 'Не удалось отправить событие. Проверьте соединение/Firebase.';
                showNotification(msg, 'error', 20000);
                showCritical(msg, e);
            });
        } catch (e) {
            console.error('❌ Ошибка отправки события в Firebase:', e);
            const msg = 'Не удалось отправить событие (ошибка в клиенте). Откройте консоль для деталей.';
            showNotification(msg, 'error', 20000);
            showCritical(msg, e);
        }
    }
    
    // Добавляем в лог
    addToLog('event', `Событие: ${name}`);
    showNotification('Событие отправлено участникам', 'success');
    
    // Очищаем форму
    const nameInput = $('#event-name-input');
    const descInput = $('#event-desc-input');
    const effectSelect = $('#event-effect-select');
    const effectParams = $('#effect-params');
    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    if (effectSelect) effectSelect.value = 'none';
    if (effectParams) effectParams.innerHTML = '';
}

function applyEventEffect(event) {
    switch (event.effect) {
        case 'limit_max':
            state.constraints[event.params.parameter] = {
                ...state.constraints[event.params.parameter],
                max: event.params.value
            };
            break;
            
        case 'limit_min':
            state.constraints[event.params.parameter] = {
                ...state.constraints[event.params.parameter],
                min: event.params.value
            };
            break;
            
        case 'lock':
            state.locks[event.params.parameter] = true;
            break;
            
        case 'lock_all':
            state.parameters.forEach(p => {
                state.locks[p.id] = true;
            });
            break;
            
        case 'force':
            // Применяем принудительное значение ко всем участникам (команда = среднее по участникам)
            if (state.participants.length > 0) {
                state.participants.forEach(p => {
                    const teamId = getParticipantTeamId(p);
                    const d = ensureParticipantDecision(p.id, teamId);
                    const row = d.parameters.find(x => x.id === event.params.parameter);
                    if (row) row.value = Number(event.params.value);
                    saveParticipantDecision(p.id);
                });
                recomputeAllTeamAggregates();
            } else {
                // fallback: старый режим (команды напрямую)
                Object.keys(state.teamsData).forEach(teamId => {
                    const teamData = state.teamsData[teamId];
                    const param = teamData.parameters.find(p => p.id === event.params.parameter);
                    if (param) param.value = event.params.value;
                });
            }
            break;
    }
}

// Действия модератора
function initModeratorActions() {
    // Добавить бота
    onId('add-bot-btn', 'click', () => {
        const usedNames = state.participants.map(p => p.name);
        const availableNames = CONFIG.botNames.filter(n => !usedNames.includes(n));
        const name = availableNames.length > 0 
            ? availableNames[Math.floor(Math.random() * availableNames.length)]
            : `Бот ${state.participants.length + 1}`;
        
        addParticipant(name, true);
        showNotification(`Бот "${name}" добавлен`, 'info');
    });
    
    // Сбросить параметры
    onId('reset-all-btn', 'click', () => {
        // Сбрасываем решения ВСЕХ участников (команды агрегируются из них)
        const defaults = createDefaultParametersArray();
        state.participants.forEach(p => {
            const teamId = getParticipantTeamId(p);
            const d = ensureParticipantDecision(p.id, teamId);
            d.parameters = defaults.map(x => ({ ...x }));
            d.confirmed = false;
            d.confirmedPhase = null;
            d.updatedAt = new Date().toISOString();
            saveParticipantDecision(p.id);
        });
        recomputeAllTeamAggregates();
        updateModeratorUI();
        addToLog('action', 'Параметры сброшены к значениям по умолчанию');
        showNotification('Параметры сброшены', 'info');
    });
    
    // Разблокировать всё
    onId('unlock-all-btn', 'click', () => {
        state.locks = {};
        state.constraints = {};
        addToLog('action', 'Все ограничения сняты');
        showNotification('Все параметры разблокированы', 'info');
    });
    
    // Принять за всех
    onId('force-confirm-btn', 'click', () => {
        const phase = Number(state.session.phase);
        const isInputPhase = (phase === 1 || phase === 4);
        state.participants.forEach(p => {
            const teamId = getParticipantTeamId(p);
            const d = ensureParticipantDecision(p.id, teamId);
            d.confirmed = true;
            d.confirmedPhase = isInputPhase ? phase : (d.confirmedPhase ?? phase);
            d.updatedAt = new Date().toISOString();
            saveParticipantDecision(p.id);
        });
        recomputeAllTeamAggregates();
        updateModeratorUI();
        addToLog('action', 'Решения приняты за всех участников');
        showNotification('Решения подтверждены за всех', 'warning');
    });
    
    // Отправить сообщение
    onId('send-broadcast', 'click', () => {
        const msgEl = $('#broadcast-message');
        const message = msgEl?.value?.trim?.() || '';
        if (message) {
            sendBroadcastMessage(message);
            showNotification('Сообщение отправлено', 'success');
            if (msgEl) msgEl.value = '';
        }
    });
    
    // Очистить лог
    onId('clear-log', 'click', () => {
        state.log = [];
        renderLog();
    });
    
    // Экспорт лога
    onId('export-log', 'click', () => {
        const text = state.log.map(e => `[${formatTime(e.time)}] ${e.message}`).join('\n');
        downloadFile('log.txt', text);
    });
}

// Лог
function addToLog(type, message) {
    const entry = {
        time: new Date(),
        type,
        message
    };
    state.log.unshift(entry);
    
    // Сохраняем данные для графика временной шкалы — ИГС команд
    const activeTeams = getActiveTeams();
    if (activeTeams.length > 0) {
        const teamIGS = {};
        activeTeams.forEach(team => {
            const igs = calculateTeamIGS(team.id);
            teamIGS[team.id] = igs.total;
        });
        
        const avgIGS = calculateAverageIGS();
        
        state.timelineData.push({
            time: entry.time,
            phase: state.session.phase,
            teamIGS: teamIGS,
            consensusIGS: avgIGS ? avgIGS.total : 0,
            conflict: calculateConflict()
        });
    }
    
    renderLog();
}

function renderLog() {
    const container = $('#log-container');
    
    if (state.log.length === 0) {
        container.innerHTML = '<div class="empty-state">Лог пуст</div>';
        return;
    }
    
    container.innerHTML = state.log.slice(0, 100).map(entry => `
        <div class="log-entry ${entry.type}">
            <span class="log-time">${formatTime(entry.time)}</span>
            <span class="log-message">${entry.message}</span>
        </div>
    `).join('');
}

// Графики
function initCharts() {
    // Chart.js может не загрузиться (нет интернета / Safari блокирует CDN).
    // В этом случае симулятор должен продолжать работать без графиков.
    if (typeof Chart === 'undefined') {
        console.warn('⚠️ Chart.js не загружен — графики отключены (симулятор продолжит работу).');
        // Прячем панель графиков, если она есть
        const chartPanel = document.querySelector('#panel-chart');
        if (chartPanel) {
            chartPanel.innerHTML = '<div class="empty-state">Графики недоступны: нет Chart.js (проверьте подключение к интернету).</div>';
        }
        return;
    }
    initRadarChart();
    initTimelineChart();
}

function initRadarChart() {
    const canvas = $('#radar-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Метки — категории ИГС
    const labels = CONFIG.parameterCategories.map(cat => `${cat.icon} ${cat.name}`);
    
    state.charts.radar = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: labels,
            datasets: []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        stepSize: 20,
                        color: '#6b7280'
                    },
                    grid: {
                        color: '#374151'
                    },
                    pointLabels: {
                        color: '#9ca3af',
                        font: {
                            family: 'Unbounded',
                            size: 11
                        }
                    }
                }
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#9ca3af',
                        font: {
                            family: 'Unbounded'
                        },
                        boxWidth: 12,
                        padding: 15
                    }
                }
            }
        }
    });
}

function initTimelineChart() {
    const canvas = $('#timeline-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Timeline показывает ИГС команд по фазам
    state.charts.timeline = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [] // Датасеты будут добавлены динамически в updateCharts
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    ticks: { color: '#6b7280' },
                    grid: { color: '#374151' }
                },
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: { color: '#6b7280' },
                    grid: { color: '#374151' }
                }
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#9ca3af',
                        font: { family: 'Unbounded' },
                        boxWidth: 12,
                        padding: 15
                    }
                }
            }
        }
    });
}

function getChartColor(index, alpha = 1) {
    const colors = [
        `rgba(6, 214, 160, ${alpha})`,
        `rgba(59, 130, 246, ${alpha})`,
        `rgba(245, 158, 11, ${alpha})`,
        `rgba(239, 68, 68, ${alpha})`,
        `rgba(168, 85, 247, ${alpha})`,
        `rgba(236, 72, 153, ${alpha})`
    ];
    return colors[index % colors.length];
}

function updateCharts() {
    if (!state.charts.radar || !state.charts.timeline) return;
    
    const activeTeams = getTeamsForAnalytics();
    
    // Radar chart — компоненты ИГС по командам
    const datasets = activeTeams.map((team, i) => {
        const igs = calculateTeamIGS(team.id);
        return {
            label: team.name,
            data: CONFIG.parameterCategories.map(cat => igs.components[cat.id]),
            borderColor: team.color,
            backgroundColor: team.color + '33', // 20% alpha
            pointBackgroundColor: team.color
        };
    });
    
    // Добавляем средний вектор (консенсус)
    const avgIGS = calculateAverageIGS();
    if (avgIGS) {
        datasets.push({
            label: `Консенсус (ИГС: ${avgIGS.total.toFixed(1)})`,
            data: CONFIG.parameterCategories.map(cat => avgIGS.components[cat.id]),
            borderColor: '#ffffff',
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 3,
            pointBackgroundColor: '#ffffff'
        });
    }
    
    state.charts.radar.data.datasets = datasets;
    state.charts.radar.update();
    
    // Timeline chart — ИГС по времени
    if (state.timelineData.length > 0) {
        state.charts.timeline.data.labels = state.timelineData.map((d, i) => 
            `Ф${d.phase}`
        );
        
        // Показываем ИГС команд и консенсуса
        const timelineDatasets = [];
        
        activeTeams.forEach((team, i) => {
            timelineDatasets.push({
                label: team.name,
                data: state.timelineData.map(d => d.teamIGS?.[team.id] || 50),
                borderColor: team.color,
                backgroundColor: team.color + '33',
                tension: 0.3,
                fill: false
            });
        });
        
        // Линия консенсуса
        timelineDatasets.push({
            label: 'Консенсус ИГС',
            data: state.timelineData.map(d => d.consensusIGS || 50),
            borderColor: '#ffffff',
            borderWidth: 3,
            tension: 0.3,
            fill: false
        });
        
        state.charts.timeline.data.datasets = timelineDatasets;
        state.charts.timeline.update();
    }
}

// Модальное окно экспорта
function initExportModal() {
    const modal = $('#export-modal');
    if (!modal) return;
    
    onId('export-menu-btn', 'click', () => {
        modal.classList.remove('hidden');
    });
    
    onEl(modal.querySelector('.modal-close'), 'click', () => {
        modal.classList.add('hidden');
    });
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.add('hidden');
        }
    });
    
    // Кнопки экспорта
    $$('.export-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            exportData(btn.dataset.format);
            modal.classList.add('hidden');
        });
    });
}

function exportData(format) {
    const data = {
        session: state.session,
        parameters: state.parameters,
        participants: state.participants,
        teams: state.teamsData,
        decisions: state.participantDecisions,
        timelineData: state.timelineData,
        log: state.log,
        exportedAt: new Date().toISOString()
    };
    let toast = true;
    
    switch (format) {
        case 'json':
            downloadFile('simulation_data.json', JSON.stringify(data, null, 2));
            break;
            
        case 'csv':
            const csv = generateCSV();
            downloadFile('simulation_data.csv', csv);
            break;
            
        case 'xlsx':
            if (typeof XLSX === 'undefined') {
                showNotification('Экспорт XLSX недоступен: библиотека XLSX не загрузилась (проверьте интернет).', 'error');
                return;
            }
            generateXLSX(data);
            break;
            
        case 'pdf':
            if (!window.jspdf || typeof window.jspdf.jsPDF === 'undefined') {
                showNotification('Экспорт PDF недоступен: библиотека jsPDF не загрузилась (проверьте интернет).', 'error');
                return;
            }
            toast = false; // успех/ошибка покажем внутри generatePDF
            Promise.resolve(generatePDF(data)).catch(() => {});
            break;
    }
    
    if (toast) {
        showNotification(`Данные экспортированы в ${format.toUpperCase()}`, 'success');
    }
}

function generateCSV() {
    // Экспорт по командам с ИГС
    const categories = CONFIG.parameterCategories.map(c => c.name);
    let csv = 'Команда,' + categories.join(',') + ',ИГС,Подтверждено\n';
    
    const activeTeams = getActiveTeams();
    activeTeams.forEach(team => {
        const igs = calculateTeamIGS(team.id);
        const teamData = getTeamData(team.id);
        const values = CONFIG.parameterCategories.map(cat => igs.components[cat.id].toFixed(1));
        csv += `${team.name},${values.join(',')},${igs.total.toFixed(1)},${teamData.confirmed ? 'Да' : 'Нет'}\n`;
    });
    
    return csv;
}

function generateXLSX(data) {
    const wb = XLSX.utils.book_new();
    const activeTeams = getActiveTeams();
    
    // Лист с командами и ИГС
    const categories = CONFIG.parameterCategories.map(c => c.name);
    const wsData = [['Команда', ...categories, 'ИГС', 'Конфликт D', 'Подтверждено']];
    
    activeTeams.forEach(team => {
        const igs = calculateTeamIGS(team.id);
        const teamData = getTeamData(team.id);
        const row = [team.name];
        CONFIG.parameterCategories.forEach(cat => {
            row.push(igs.components[cat.id].toFixed(1));
        });
        row.push(igs.total.toFixed(1));
        row.push(igs.components.D.toFixed(1));
        row.push(teamData.confirmed ? 'Да' : 'Нет');
        wsData.push(row);
    });
    
    // Строка консенсуса
    const avgIGS = calculateAverageIGS();
    if (avgIGS) {
        const avgRow = ['КОНСЕНСУС'];
        CONFIG.parameterCategories.forEach(cat => {
            avgRow.push(avgIGS.components[cat.id].toFixed(1));
        });
        avgRow.push(avgIGS.total.toFixed(1));
        avgRow.push(calculateConflict().toFixed(1));
        avgRow.push('-');
        wsData.push(avgRow);
    }
    
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Команды и ИГС');
    
    // Лист с участниками
    const participantsData = [['Имя', 'Реальная роль', 'Игровая роль', 'Команда', 'Капитан']];
    state.participants.forEach(p => {
        participantsData.push([
            p.name,
            CONFIG.realRoles[p.realRole]?.name || '-',
            p.gameRole?.name || '-',
            p.team?.name || '-',
            p.isCaptain ? 'Да' : 'Нет'
        ]);
    });
    const wsParticipants = XLSX.utils.aoa_to_sheet(participantsData);
    XLSX.utils.book_append_sheet(wb, wsParticipants, 'Участники');
    
    // Лист с логом
    const logData = [['Время', 'Тип', 'Сообщение']];
    state.log.forEach(e => {
        logData.push([formatDateTime(e.time), e.type, e.message]);
    });
    const wsLog = XLSX.utils.aoa_to_sheet(logData);
    XLSX.utils.book_append_sheet(wb, wsLog, 'Лог');
    
    XLSX.writeFile(wb, 'simulation_data.xlsx');
}

function buildProtocolSnapshot() {
    const activeTeams = getActiveTeams();
    const exportedAt = new Date();
    const avgIGS = calculateAverageIGS();
    const conflict = calculateConflict();

    const participants = (state.participants || []).map(p => ({
        id: p.id,
        name: p.name,
        isBot: !!p.isBot,
        teamId: p.team?.id || (typeof p.team === 'string' ? p.team : null),
        teamName: p.team?.name || '-',
        realRole: CONFIG.realRoles[p.realRole]?.name || '-',
        gameRole: p.gameRole?.name || '-',
        isCaptain: !!p.isCaptain
    }));

    const teams = activeTeams.map(team => {
        const teamData = getTeamData(team.id);
        const members = getTeamMembers(team.id).map(m => ({
            id: m.id,
            name: m.name,
            isBot: !!m.isBot,
            realRole: CONFIG.realRoles[m.realRole]?.name || '-',
            gameRole: m.gameRole?.name || '-',
            isCaptain: isCaptain(m.id)
        }));
        const igs = calculateTeamIGS(team.id);
        const budgetUsed = calculateBudgetUsed(teamData.parameters);
        const phase = Number(state.session.phase);
        const prog = getTeamDecisionProgress(team.id, phase);
        return {
            id: team.id,
            name: team.name,
            color: team.color,
            igs,
            budgetUsed,
            confirmed: !!teamData.confirmed,
            progress: prog,
            parameters: teamData.parameters.map(p => ({ id: p.id, value: p.value })),
            members
        };
    });

    const decisions = normalizeDecisionsMap(state.participantDecisions || {});

    return {
        exportedAt: exportedAt.toISOString(),
        session: {
            code: state.session.code,
            name: state.session.name,
            createdAt: state.session.createdAt ? new Date(state.session.createdAt).toISOString?.() || String(state.session.createdAt) : null,
            phase: state.session.phase,
            projectScale: state.session.projectScale,
            budgetLevel: state.session.budgetLevel,
            budgetTotal: state.session.budgetTotal
        },
        summary: {
            participantsCount: participants.length,
            teamsCount: activeTeams.length,
            consensusIGS: avgIGS ? avgIGS.total : null,
            conflictD: conflict
        },
        teams,
        participants,
        decisions,
        timeline: (state.timelineData || []).map(d => ({
            time: d.time ? new Date(d.time).toISOString?.() || String(d.time) : null,
            phase: d.phase,
            teamIGS: d.teamIGS || {},
            consensusIGS: d.consensusIGS,
            conflict: d.conflict
        })),
        log: (state.log || []).map(e => ({
            time: e.time ? new Date(e.time).toISOString?.() || String(e.time) : null,
            type: e.type,
            message: e.message
        })),
        config: {
            igsWeights: CONFIG.igsWeights,
            parameterCategories: CONFIG.parameterCategories.map(c => ({
                id: c.id,
                name: c.name,
                source: c.source,
                weight: c.weight,
                params: c.params.map(p => ({ id: p.id, name: p.name, unit: p.unit, default: p.default, min: p.min, max: p.max, weight: p.weight }))
            }))
        }
    };
}

function renderProtocolHTML(snapshot) {
    const s = snapshot;
    const allParams = getAllParameters();
    const paramMeta = new Map(allParams.map(p => [p.id, p]));

    const row = (k, v) => `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(v ?? '')}</td></tr>`;
    const fmt = (v, digits = 1) => (typeof v === 'number' && !Number.isNaN(v)) ? v.toFixed(digits) : (v ?? '—');

    const teamsHTML = s.teams.map(t => {
        const paramsRows = t.parameters.map(p => {
            const meta = paramMeta.get(p.id);
            const name = meta?.name || p.id;
            const unit = meta?.unit || '';
            const def = meta?.default;
            const delta = (typeof def === 'number') ? (p.value - def) : null;
            return `<tr>
                <td>${escapeHtml(p.id)}</td>
                <td>${escapeHtml(name)}</td>
                <td class="num">${fmt(p.value, 1)}${escapeHtml(unit)}</td>
                <td class="num">${typeof def === 'number' ? fmt(def, 1) : '—'}${escapeHtml(unit)}</td>
                <td class="num">${typeof delta === 'number' ? fmt(delta, 1) : '—'}${escapeHtml(unit)}</td>
            </tr>`;
        }).join('');

        const membersRows = t.members.map(m => {
            const cap = m.isCaptain ? '👑 ' : '';
            return `<tr>
                <td>${escapeHtml(cap + (m.name || '—'))}</td>
                <td>${escapeHtml(m.realRole)}</td>
                <td>${escapeHtml(m.gameRole)}</td>
                <td>${escapeHtml(m.isBot ? 'Да' : 'Нет')}</td>
            </tr>`;
        }).join('');

        // Решения участников в команде (полная раскладка параметров — длинно, но “протокол”)
        const decisionsRows = t.members.map(m => {
            const d = s.decisions?.[m.id];
            const confirmed = d?.confirmed ? `Да (фаза ${d.confirmedPhase ?? '—'})` : 'Нет';
            const updatedAt = d?.updatedAt || '—';
            const myParams = (d?.parameters || []).map(pp => {
                const meta = paramMeta.get(pp.id);
                const unit = meta?.unit || '';
                return `<tr>
                    <td>${escapeHtml(m.name || '—')}</td>
                    <td>${escapeHtml(pp.id)}</td>
                    <td>${escapeHtml(meta?.name || pp.id)}</td>
                    <td class="num">${fmt(pp.value, 1)}${escapeHtml(unit)}</td>
                </tr>`;
            }).join('');
            return `<div class="subblock">
                <div class="subhead">${escapeHtml(m.name || '—')} — подтверждение: <strong>${escapeHtml(confirmed)}</strong>, обновлено: ${escapeHtml(updatedAt)}</div>
                <table class="tbl small">
                    <thead><tr><th>Участник</th><th>ID</th><th>Параметр</th><th>Значение</th></tr></thead>
                    <tbody>${myParams || `<tr><td colspan="4">Нет данных</td></tr>`}</tbody>
                </table>
            </div>`;
        }).join('');

        const prog = t.progress || { confirmed: 0, total: t.members.length };

        return `
        <div class="block">
            <div class="h2">${escapeHtml(t.name)} (id: ${escapeHtml(t.id)})</div>
            <div class="meta">ИГС: <strong>${fmt(t.igs?.total, 1)}</strong> · Конфликт D: <strong>${fmt(t.igs?.components?.D, 1)}</strong> · Бюджет: <strong>${fmt(t.budgetUsed, 0)}</strong> / ${escapeHtml(String(s.session.budgetTotal))}</div>
            <div class="meta">Подтверждение команды (по участникам): <strong>${escapeHtml(String(prog.confirmed))}/${escapeHtml(String(prog.total))}</strong></div>

            <div class="h3">Состав команды</div>
            <table class="tbl">
                <thead><tr><th>Имя</th><th>Реальная роль</th><th>Игровая роль</th><th>Бот</th></tr></thead>
                <tbody>${membersRows || `<tr><td colspan="4">Нет участников</td></tr>`}</tbody>
            </table>

            <div class="h3">Агрегированное решение команды (среднее)</div>
            <table class="tbl">
                <thead><tr><th>ID</th><th>Параметр</th><th>Значение</th><th>Дефолт</th><th>Δ</th></tr></thead>
                <tbody>${paramsRows}</tbody>
            </table>

            <div class="h3">Решения участников (подробно)</div>
            ${decisionsRows || `<div class="meta">Нет данных решений</div>`}
        </div>
        `;
    }).join('');

    const participantsRows = s.participants.map(p => `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.teamName)}</td>
        <td>${escapeHtml(p.realRole)}</td>
        <td>${escapeHtml(p.gameRole)}</td>
        <td>${escapeHtml(p.isCaptain ? 'Да' : 'Нет')}</td>
        <td>${escapeHtml(p.isBot ? 'Да' : 'Нет')}</td>
        <td class="mono">${escapeHtml(p.id)}</td>
    </tr>`).join('');

    const logRows = s.log.slice(0, 400).map(e => `<tr>
        <td class="mono">${escapeHtml(e.time || '')}</td>
        <td>${escapeHtml(e.type || '')}</td>
        <td>${escapeHtml(e.message || '')}</td>
    </tr>`).join('');

    const timelineRows = s.timeline.map(d => `<tr>
        <td class="mono">${escapeHtml(d.time || '')}</td>
        <td class="num">${escapeHtml(String(d.phase ?? ''))}</td>
        <td class="num">${fmt(d.consensusIGS, 1)}</td>
        <td class="num">${fmt(d.conflict, 1)}</td>
    </tr>`).join('');

    return `
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<title>Протокол симуляции — ${escapeHtml(s.session.code || '')}</title>
<style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #0f172a; margin: 0; padding: 24px; }
    .title { font-size: 20px; font-weight: 800; margin-bottom: 6px; }
    .subtitle { color: #334155; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    .block { border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
    .h2 { font-size: 16px; font-weight: 800; margin: 0 0 6px; }
    .h3 { font-size: 13px; font-weight: 800; margin: 14px 0 6px; }
    .meta { font-size: 12px; color: #334155; margin: 4px 0; }
    .tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
    .tbl th, .tbl td { border: 1px solid #e2e8f0; padding: 6px 8px; vertical-align: top; }
    .tbl th { background: #f8fafc; text-align: left; }
    .tbl.small { font-size: 11px; }
    .num { text-align: right; white-space: nowrap; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; }
    .kv { width: 100%; border-collapse: collapse; font-size: 12px; }
    .kv td { border: 1px solid #e2e8f0; padding: 6px 8px; }
    .kv .k { width: 220px; background: #f8fafc; color: #334155; font-weight: 700; }
    .subblock { border: 1px dashed #cbd5e1; border-radius: 10px; padding: 10px; margin: 8px 0; }
    .subhead { font-size: 12px; color: #0f172a; margin-bottom: 6px; }
    .pagebreak { page-break-before: always; }
</style>
</head>
<body>
    <div class="title">Подробный протокол симуляции (ИГС)</div>
    <div class="subtitle">Сгенерировано: <span class="mono">${escapeHtml(s.exportedAt)}</span></div>

    <div class="block">
        <div class="h2">Сессия</div>
        <table class="kv">
            ${row('Название', s.session.name)}
            ${row('Код', s.session.code)}
            ${row('Создана', s.session.createdAt || '—')}
            ${row('Фаза (финальная)', String(s.session.phase))}
            ${row('Масштаб', s.session.projectScale)}
            ${row('Бюджет', `${s.session.budgetTotal} (уровень: ${s.session.budgetLevel})`)}
            ${row('Команд', String(s.summary.teamsCount))}
            ${row('Участников', String(s.summary.participantsCount))}
            ${row('ИГС консенсуса', fmt(s.summary.consensusIGS, 1))}
            ${row('Конфликт D', fmt(s.summary.conflictD, 1))}
        </table>
    </div>

    <div class="block">
        <div class="h2">Участники (полный список)</div>
        <table class="tbl">
            <thead><tr><th>Имя</th><th>Команда</th><th>Реальная роль</th><th>Игровая роль</th><th>Капитан</th><th>Бот</th><th>ID</th></tr></thead>
            <tbody>${participantsRows || `<tr><td colspan="7">Нет участников</td></tr>`}</tbody>
        </table>
    </div>

    <div class="block">
        <div class="h2">Динамика (по логам)</div>
        <div class="meta">Точки формируются при добавлении записей в лог (см. `addToLog`).</div>
        <table class="tbl">
            <thead><tr><th>Время</th><th>Фаза</th><th>ИГС консенсуса</th><th>Конфликт</th></tr></thead>
            <tbody>${timelineRows || `<tr><td colspan="4">Нет данных</td></tr>`}</tbody>
        </table>
    </div>

    <div class="pagebreak"></div>
    <div class="title">Команды и решения</div>
    <div class="grid">
        ${teamsHTML || `<div class="block">Нет команд</div>`}
    </div>

    <div class="pagebreak"></div>
    <div class="block">
        <div class="h2">Лог (первые 400 записей)</div>
        <table class="tbl">
            <thead><tr><th>Время</th><th>Тип</th><th>Сообщение</th></tr></thead>
            <tbody>${logRows || `<tr><td colspan="3">Нет логов</td></tr>`}</tbody>
        </table>
        <div class="meta">Полный лог и данные решений можно выгрузить в JSON/XLSX.</div>
    </div>
</body>
</html>`;
}

function exportProtocolHTML() {
    const snap = buildProtocolSnapshot();
    const html = renderProtocolHTML(snap);
    const safeCode = (state.session.code || 'session').replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    downloadFile(`protocol_${safeCode}.html`, html, 'text/html;charset=utf-8');
    showNotification('Протокол (HTML) скачан', 'success');
}

async function generatePDF(data) {
    // Новый PDF: HTML→Canvas→PDF, чтобы кириллица была корректной
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });

    const snap = buildProtocolSnapshot();
    const html = renderProtocolHTML(snap);

    // Временный контейнер вне экрана
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    host.style.top = '0';
    host.style.width = '794px'; // примерно A4 в px при 96dpi
    host.innerHTML = html;

    // Берём только body содержимое из сгенерированного HTML
    let bodyNode = null;
    try {
        bodyNode = host.querySelector('body');
    } catch (_) {}
    const renderNode = bodyNode || host;
    document.body.appendChild(host);

    if (typeof doc.html !== 'function') {
        document.body.removeChild(host);
        showNotification('PDF-протокол недоступен в этой сборке jsPDF. Скачайте HTML и распечатайте в PDF.', 'warning', 12000);
        exportProtocolHTML();
        return;
    }

    const safeCode = (state.session.code || 'session').replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `protocol_${safeCode}.pdf`;

    try {
        await doc.html(renderNode, {
            margin: [24, 24, 24, 24],
            autoPaging: 'text',
            html2canvas: {
                scale: 0.8,
                useCORS: true
            },
            callback: (pdf) => {
                pdf.save(filename);
                showNotification('Протокол (PDF) скачан', 'success');
            }
        });
    } catch (e) {
        console.error('❌ Ошибка генерации PDF протокола:', e);
        showNotification('Не удалось сформировать PDF. Скачал HTML как запасной вариант.', 'error', 12000);
        exportProtocolHTML();
    } finally {
        try { document.body.removeChild(host); } catch (_) {}
    }
}

function downloadFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// =====================================================
// ИНИЦИАЛИЗАЦИЯ
// =====================================================

document.addEventListener('DOMContentLoaded', () => {
    try {
        console.log('🚀 Инициализация симулятора...');
        console.log('🧩 Build:', '2026-01-10', 'rev', '20260110-3');
        console.log('📊 Категорий параметров:', CONFIG.parameterCategories.length);
        console.log('👥 Команд:', CONFIG.teams.length);

        try {
            const badge = document.getElementById('build-badge');
            if (badge) badge.textContent = 'Build: 20260110-3';
        } catch (_) {}
        
        // Инициализируем Firebase
        initFirebase();
        
        initLoginScreen();
        
        // Страховка: если по какой-то причине initLoginScreen не навесил handlers,
        // делаем делегирование кликов на уровне документа.
        document.addEventListener('click', (e) => {
            try {
                // Переключение вкладок логина (join/create) — всегда доступно
                const tabBtn = e?.target?.closest?.('.login-tabs .tab-btn');
                if (tabBtn && tabBtn.dataset?.tab && state.mode === 'login') {
                    const tab = tabBtn.dataset.tab;
                    $$('.login-tabs .tab-btn').forEach(b => b.classList.toggle('active', b === tabBtn));
                    const joinForm = $('#join-form');
                    const createForm = $('#create-form');
                    if (joinForm?.classList) joinForm.classList.toggle('hidden', tab !== 'join');
                    if (createForm?.classList) createForm.classList.toggle('hidden', tab !== 'create');
                    return;
                }

                const t = e?.target;
                if (!t || !t.id) return;
                if (t.id !== 'create-btn' && t.id !== 'join-btn') return;
                if (state.mode !== 'login') return;
                if (state.ui?.loginHandlersReady) return;
                console.warn('⚠️ Fallback login handler fired for', t.id);
                initLoginScreen();
            } catch (_) {}
        }, true);
        
        initEndgameOverlay();
        console.log('✅ Симулятор загружен');
    } catch (error) {
        console.error('❌ Ошибка инициализации:', error);
        alert('Ошибка загрузки приложения: ' + error.message);
    }
});

