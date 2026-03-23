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

// =====================================================
// ТАЙМЕРЫ ФАЗ
// =====================================================

function isDecisionTimerPhase(phase) {
    const p = Number(phase);
    return Array.isArray(CONFIG.decisionTimers?.phases) && CONFIG.decisionTimers.phases.includes(p);
}

function getTimerForPhase(phase) {
    const p = Number(phase);
    return state.session.timers?.[p] || null;
}

function getTimerRemainingSec(phase) {
    const t = getTimerForPhase(phase);
    if (!t) return null;
    const startedAtMs = parseStartedAtMs(t.startedAt);
    const durationSec = Number(t.durationSec ?? CONFIG.decisionTimers.durationSec);
    if (!startedAtMs || !Number.isFinite(durationSec)) return null;
    const elapsedSec = (Date.now() - startedAtMs) / 1000;
    return Math.max(0, Math.ceil(durationSec - elapsedSec));
}

function ensureTimerTicking() {
    if (!state.ui || typeof state.ui !== 'object') state.ui = {};
    if (!state.ui.timerNotified) state.ui.timerNotified = {}; // legacy (используем для 0 сек)
    if (!state.ui.timerMilestonesNotified) state.ui.timerMilestonesNotified = {}; // { [phase]: { start:true, t180:true, t0:true } }
    if (state.ui.timerIntervalId) return;

    state.ui.timerIntervalId = setInterval(() => {
        updatePhaseTimerUI();
        const p = Number(state.session.phase);
        if (!isDecisionTimerPhase(p)) return;
        const remaining = getTimerRemainingSec(p);
        if (remaining === null) return;
        const key = String(p);
        if (!state.ui.timerMilestonesNotified[key]) state.ui.timerMilestonesNotified[key] = {};
        const flags = state.ui.timerMilestonesNotified[key];

        // Старт (10 минут) — показываем сразу, как только таймер появился/обновился
        if (!flags.start && remaining <= CONFIG.decisionTimers.durationSec && remaining > CONFIG.decisionTimers.durationSec - 2) {
            flags.start = true;
            showNotification('⏳ Осталось 10 минут, чтобы принять решения', 'info');
        }

        // 3 минуты осталось
        if (!flags.t180 && remaining <= 180 && remaining > 178) {
            flags.t180 = true;
            showNotification('⏳ Осталось 3 минуты, чтобы принять решения', 'warning');
        }

        // Время вышло
        if (remaining <= 0 && !flags.t0) {
            flags.t0 = true;
            state.ui.timerNotified[key] = true;
            showNotification('⏰ Время истекло на принятие решений', 'warning');
            // Важно: фазу переключает только модератор вручную
        }
    }, 1000);
}

function updatePhaseTimerUI() {
    const p = Number(state.session.phase);
    const isTimerPhase = isDecisionTimerPhase(p);
    const ids = ['p-phase-timer', 'm-phase-timer'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!isTimerPhase) {
            el.textContent = '';
            el.classList.add('hidden');
            return;
        }
        el.classList.remove('hidden');
        const remaining = getTimerRemainingSec(p);
        if (remaining === null) {
            el.textContent = '⏳ 10:00';
            return;
        }
        el.textContent = `⏳ ${formatDuration(remaining)}`;
        el.classList.toggle('timer-expired', remaining <= 0);
    });
}

function startPhaseTimer(phase, durationSec = CONFIG.decisionTimers.durationSec) {
    const p = Number(phase);
    if (!Number.isFinite(p)) return;
    const payload = { startedAt: new Date().toISOString(), durationSec: Number(durationSec) };
    // Сброс локальных уведомлений по вехам для этой фазы
    if (!state.ui || typeof state.ui !== 'object') state.ui = {};
    if (!state.ui.timerMilestonesNotified) state.ui.timerMilestonesNotified = {};
    state.ui.timerMilestonesNotified[String(p)] = {};

    // Локальный режим
    if (!firebaseEnabled) {
        if (!state.session.code) return;
        const existing = localReadSession(state.session.code) || {};
        existing.timers = existing.timers || {};
        existing.timers[p] = payload;
        localWriteSession(state.session.code, existing);
        localBroadcast({ type: 'timers_update', code: state.session.code, timers: existing.timers });
        localBroadcast({ type: 'session_update', code: state.session.code, data: existing });
        // Применим локально
        state.session.timers = { ...(state.session.timers || {}), [p]: payload };
        updatePhaseTimerUI();
        ensureTimerTicking();
        return;
    }

    if (!state.session.code) return;
    try {
        const ref = firebaseDB.ref(`sessions/${state.session.code}/timers/${p}`);
        ref.set(payload).catch(e => console.error('❌ Ошибка записи таймера:', e));
    } catch (e) {
        console.error('❌ Ошибка записи таймера:', e);
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
            if (msg.participant) {
                const incoming = ensureParticipantMeta(msg.participant);
                const idx = state.participants.findIndex(p => p.id === incoming.id);
                if (idx >= 0) state.participants[idx] = incoming;
                else state.participants.push(incoming);
                if (incoming.team) initTeamData(incoming.team.id);
                if (state.user.isModerator) {
                    renderParticipantsList();
                    renderParamsMatrix();
                    updateMetrics();
                }
            }
            break;
        case 'teams_update':
            if (msg.teams) {
                Object.keys(msg.teams).forEach(teamId => {
                    state.teamsData[teamId] = msg.teams[teamId];
                });
                syncCaptainFlagsFromTeams();
                if (state.user.isModerator) {
                    renderParticipantsList();
                    renderParamsMatrix();
                    renderAvgParams();
                    updateMetrics();
                    updateCharts();
                } else {
                    updateIGSDisplay();
                    renderRoleCard();
                    renderParameters();
                    renderCaptainMatrix();
                    updateConfirmButton();
                }
            }
            break;
        case 'timers_update':
            if (msg.timers) {
                state.session.timers = msg.timers;
                updatePhaseTimerUI();
                ensureTimerTicking();
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
    // Данные в localStorage храним как { session, phase, participants, teams }
    if (data.session) {
        // createdAt может быть строкой
        const createdAt = data.session.createdAt ? new Date(data.session.createdAt) : state.session.createdAt;
        // Игнорируем data.session.phase: фазу храним отдельным полем data.phase
        const { phase, ...rest } = data.session;
        state.session = { ...state.session, ...rest, createdAt };
        if (typeof data.phase === 'number') state.session.phase = data.phase;
    }
    if (data.participants) {
        state.participants = Object.values(data.participants).map(p => ensureParticipantMeta(p));
        // Инициализация teamData для всех команд
        state.participants.forEach(p => p.team && initTeamData(p.team.id));
    }
    if (data.teams) {
        state.teamsData = { ...state.teamsData, ...data.teams };
    }
    if (data.timers) {
        state.session.timers = data.timers;
    }
    syncCaptainFlagsFromTeams();
    updatePhaseUI();
    updatePhaseTimerUI();
    ensureTimerTicking();
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
        return true;
    } catch (error) {
        console.error('❌ Ошибка Firebase:', error);
        return false;
    }
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
                    const participant = ensureParticipantMeta(participants[participantId]);
                    console.log('  ➕ Добавляю участника:', participant.name);
                    if (!state.participants.find(p => p.id === participant.id)) {
                        state.participants.push(participant);
                        
                        // Инициализируем данные команды если нужно
                        if (participant.team) {
                            initTeamData(participant.team.id);
                        }
                    }
                });
                
                console.log('✅ Загружено участников:', state.participants.length);
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
        const participant = ensureParticipantMeta(snapshot.val());
        console.log('🔔 child_added сработал! Участник:', participant?.name, 'Модератор?', state.user.isModerator);
        
        if (participant) {
            const idx = state.participants.findIndex(p => p.id === participant.id);
            if (idx >= 0) {
                state.participants[idx] = participant;
            } else {
                console.log('➕ Новый участник:', participant.name, 'Команда:', participant.team?.name);
                state.participants.push(participant);
            }
            
            // Инициализируем данные команды если нужно
            if (participant.team) {
                initTeamData(participant.team.id);
            }
            
            if (state.user.isModerator) {
                console.log('🔄 Обновляю UI модератора...');
                renderParticipantsList();
                renderParamsMatrix();
                updateMetrics();
                console.log('✅ UI модератора обновлён. Всего участников:', state.participants.length);
            }
        }
    });

    // Слушаем изменения участников (подтверждения, смена роли и т.п.)
    sessionRef.child('participants').on('child_changed', (snapshot) => {
        const participant = ensureParticipantMeta(snapshot.val());
        if (!participant) return;
        const idx = state.participants.findIndex(p => p.id === participant.id);
        if (idx >= 0) state.participants[idx] = participant;
        else state.participants.push(participant);
        if (participant.team) initTeamData(participant.team.id);
        if (state.user.isModerator) {
            renderParticipantsList();
            renderParamsMatrix();
            updateMetrics();
        } else {
            // Обновим статус кнопки подтверждения и текст (решение могло стать "устаревшим")
            updateConfirmButton();
            renderParticipantInsights();
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

            // Синхронизируем p.isCaptain по captainId из teamsData (для списков/экспорта)
            syncCaptainFlagsFromTeams();
            
            if (state.user.isModerator) {
                renderParticipantsList();
                renderParamsMatrix();
                renderAvgParams();
                updateMetrics();
                updateCharts();
            } else {
                updateIGSDisplay();
                renderRoleCard();
                renderParameters();
                renderCaptainMatrix();
                updateConfirmButton();
                renderParticipantInsights();
            }
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
                renderParticipantInsights();
                showNotification(`Фаза ${phase}: ${CONFIG.phases[phase]?.name}`, 'success');
            }
            
            addToLog('phase', `Переход к фазе ${phase}: ${CONFIG.phases[phase]?.name}`);
        }
    });

    // Таймеры фаз
    sessionRef.child('timers').on('value', (snapshot) => {
        const timers = snapshot.val() || {};
        state.session.timers = timers;
        updatePhaseTimerUI();
        ensureTimerTicking();
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
            renderParticipantInsights();
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
        if (!state.session.code) return Promise.resolve(false);
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
            teams: existing.teams || {}
        };
        localWriteSession(state.session.code, data);
        localBroadcast({ type: 'session_update', code: state.session.code, data });
        return Promise.resolve(true);
    }
    if (!state.session.code) {
        console.log('⚠️ saveSessionToFirebase: нет кода сессии');
        return Promise.resolve(false);
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
    
    return sessionRef.update(data).then(() => {
        console.log('✅ Сессия сохранена в Firebase');
        return true;
    }).catch((error) => {
        console.error('❌ Ошибка сохранения сессии:', error);
        return false;
    });
}

// Сохранение участника в Firebase
function saveParticipantToFirebase(participant) {
    // Локальный режим
    if (!firebaseEnabled) {
        if (!state.session.code) return Promise.resolve(false);
        const existing = localReadSession(state.session.code);
        if (!existing) {
            console.warn('⚠️ LocalSync: сессия не найдена для сохранения участника');
            return Promise.resolve(false);
        }
        existing.participants = existing.participants || {};
        existing.participants[participant.id] = participant;
        localWriteSession(state.session.code, existing);
        localBroadcast({ type: 'participants_child_added', code: state.session.code, participant });
        // Также шлём полный слепок (на случай позднего подключения вкладки)
        localBroadcast({ type: 'session_update', code: state.session.code, data: existing });
        return Promise.resolve(true);
    }
    if (!state.session.code) {
        console.log('⚠️ saveParticipantToFirebase: нет кода сессии');
        return Promise.resolve(false);
    }
    
    console.log('💾 Сохраняю участника в Firebase:', participant.name, 'ID:', participant.id);
    
    const participantRef = firebaseDB.ref(`sessions/${state.session.code}/participants/${participant.id}`);
    return participantRef.set(participant).then(() => {
        console.log('✅ Участник сохранён в Firebase:', participant.name);
        return true;
    }).catch((error) => {
        console.error('❌ Ошибка сохранения участника:', error);
        return false;
    });
}

// Сохранение данных команды в Firebase
function saveTeamToFirebase(teamId) {
    // Локальный режим
    if (!firebaseEnabled) {
        if (!state.session.code) return Promise.resolve(false);
        const existing = localReadSession(state.session.code);
        if (!existing) {
            console.warn('⚠️ LocalSync: сессия не найдена для сохранения команды');
            return Promise.resolve(false);
        }
        existing.teams = existing.teams || {};
        existing.teams[teamId] = state.teamsData[teamId];
        localWriteSession(state.session.code, existing);
        localBroadcast({ type: 'teams_update', code: state.session.code, teams: { [teamId]: existing.teams[teamId] } });
        return Promise.resolve(true);
    }
    if (!state.session.code) {
        console.log('⚠️ saveTeamToFirebase: нет кода сессии');
        return Promise.resolve(false);
    }
    
    const teamData = state.teamsData[teamId];
    console.log(`💾 Сохраняю команду ${teamId} в Firebase:`, {
        confirmed: teamData.confirmed,
        parametersCount: teamData.parameters.length
    });
    
    const teamRef = firebaseDB.ref(`sessions/${state.session.code}/teams/${teamId}`);
    return teamRef.set(teamData).then(() => {
        console.log(`✅ Команда ${teamId} сохранена в Firebase`);
        return true;
    }).catch((error) => {
        console.error(`❌ Ошибка сохранения команды ${teamId}:`, error);
        return false;
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
            totalPoints: 80
        },
        medium: { 
            name: 'Стандартный', 
            multiplier: 1.0, 
            desc: 'Типичный бюджет благоустройства',
            icon: '💰💰',
            totalPoints: 120
        },
        high: { 
            name: 'Расширенный', 
            multiplier: 1.5, 
            desc: 'Приоритетный проект',
            icon: '💰💰💰',
            totalPoints: 180
        }
    },

    // Лимит "ходов" (кол-во разных ползунков, которые капитан может изменить за фазу ввода)
    // Связано с уровнем бюджета, как вы просили: 800→4, 1200→6, 1800→8
    moveLimitsByBudgetLevel: {
        low: 4,
        medium: 6,
        high: 8
    },

    // Поправка лимита "ходов" под масштаб проекта (мягко, чтобы не ломать баланс)
    // Идея: на крупном объекте чуть больше свободы выбора параметров, на малом — чуть меньше.
    moveLimitAdjustByProjectScale: {
        small: -1,
        medium: 0,
        large: 1
    },
    
    // Стоимость изменения параметров (очков за +10 единиц)
    parameterCosts: {
        // Калибровка под "фишки влияния":
        // - 5–6 умеренных изменений обычно помещаются в 120
        // - 5–6 "выкрутить в максимум" почти всегда упираются в бюджет
        Z: 9,
        R: 5,
        Tg: 6,
        N: 8,
        Df: 4,
        Af: 7,
        M: 10,
        Pt: 5,
        B: 7,
        I: 9,
        U: 6,
        As: 6,
        O: 5,
        V: 4,
        L: 8,
        Ca: 8,
        Tp: 8
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
                { id: 'N', name: 'Коммерция и активности (точки притяжения)', desc: 'Насколько много функций и активностей: сервисы, спорт, отдых, события', weight: 0.43, min: 0, max: 100, default: 40, unit: '' },
                { id: 'Df', name: 'Распределение функций по территории', desc: 'Насколько равномерно функции распределены, а не сконцентрированы в одной точке', weight: 0.24, min: 0, max: 100, default: 50, unit: '' },
                { id: 'Af', name: 'Оживлённость первых этажей (витрины/кафе)', desc: 'Насколько пространство “живое”: витрины, входы, глаза на улице, активные фасады', weight: 0.33, min: 0, max: 100, default: 45, unit: '' }
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
                { id: 'I', name: 'Безбарьерность', desc: 'Инклюзивный дизайн: удобно МГН, с колясками, пожилым, детям', weight: 0.45, min: 0, max: 100, default: 40, unit: '' },
                { id: 'U', name: 'Удобство для разных возрастов', desc: 'Насколько среда универсальна: детям, подросткам, взрослым и пожилым', weight: 0.25, min: 0, max: 100, default: 50, unit: '' },
                { id: 'As', name: 'Влияние жителей на решения', desc: 'Насколько сильно мнение жителей влияет на правила и решения по территории', weight: 0.30, min: 0, max: 100, default: 30, unit: '' }
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
                { id: 'O', name: 'Освещённость', desc: 'Качество уличного освещения', weight: 0.35, min: 0, max: 100, default: 55, unit: '' },
                { id: 'V', name: 'Просматриваемость', desc: 'Визуальная безопасность: видно людей и маршруты, меньше “слепых зон”', weight: 0.25, min: 0, max: 100, default: 60, unit: '' },
                { id: 'L', name: 'Тишина и спокойствие', desc: 'Низкий уровень шума и отсутствие постоянной “бурной” активности (100 = максимально тихо)', weight: 0.40, min: 0, max: 100, default: 45, unit: '' }
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
                { id: 'Ca', name: 'Асфальт и покрытия', desc: 'Доля твёрдых покрытий (асфальт/бетон) — обычно в ущерб зелени и “мягким” пространствам', weight: 0.50, min: 0, max: 100, default: 60, unit: '%' },
                { id: 'Tp', name: 'Автотрафик', desc: 'Интенсивность движения и доминирование автомобилей на территории', weight: 0.50, min: 0, max: 100, default: 50, unit: '' }
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

    // Таймеры (сек) для фаз принятия решений
    decisionTimers: {
        phases: [1, 4],      // Раунд 1 и Раунд 2
        durationSec: 10 * 60 // 10 минут
    },
    
    // Шаблоны событий
    eventTemplates: {
        budget: {
            name: '💰 Сокращение бюджета',
            desc: 'Из-за экономической ситуации ресурсы ограничены. Сделайте компромиссы: уменьшите трафик и твёрдое покрытие, сфокусируйтесь на базовых улучшениях.',
            effect: 'none',
            params: {},
            actions: [
                { effect: 'limit_max', parameter: 'Ca', value: 55 },
                { effect: 'limit_max', parameter: 'Tp', value: 45 }
            ]
        },
        protest: {
            name: '📣 Протест жителей',
            desc: 'Жители требуют меньше асфальта и больше зелени: снизьте твёрдое покрытие и повысьте озеленение.',
            effect: 'none',
            params: {},
            actions: [
                { effect: 'limit_max', parameter: 'Ca', value: 50 },
                { effect: 'limit_min', parameter: 'Z', value: 40 }
            ]
        },
        eco: {
            name: '🌿 Экологическое требование',
            desc: 'Экологическая экспертиза требует увеличить озеленение минимум до 40%.',
            effect: 'limit_min',
            params: { parameter: 'Z', value: 40 }
        },
        investor: {
            name: '🏗️ Интерес инвестора',
            desc: 'Инвестор поддержит проект при условии развития функций и активных фасадов.',
            effect: 'none',
            params: {},
            actions: [
                { effect: 'limit_min', parameter: 'N', value: 55 },
                { effect: 'limit_min', parameter: 'Af', value: 55 }
            ]
        },
        tech: {
            name: '⚠️ Технический сбой',
            desc: 'Обнаружены проблемы с инфраструктурой. Часть параметров временно заблокирована.',
            effect: 'none',
            params: {},
            actions: [
                { effect: 'lock', parameter: 'O' },   // освещённость
                { effect: 'lock', parameter: 'B' }    // велоинфраструктура
            ]
        },
        noise: {
            name: '🔇 Жалобы на шум',
            desc: 'Жители жалуются на шум. Нужно повысить тишину и снизить трафик.',
            effect: 'none',
            params: {},
            actions: [
                { effect: 'limit_min', parameter: 'L', value: 60 },
                { effect: 'limit_max', parameter: 'Tp', value: 40 }
            ]
        },
        safety: {
            name: '🚨 Запрос на безопасность',
            desc: 'Город просит повысить визуальную безопасность и освещённость.',
            effect: 'none',
            params: {},
            actions: [
                { effect: 'limit_min', parameter: 'V', value: 65 },
                { effect: 'limit_min', parameter: 'O', value: 65 }
            ]
        },
        heat: {
            name: '☀️ Жара',
            desc: 'Аномальная жара. Требуется больше тени и зелени.',
            effect: 'none',
            params: {},
            actions: [
                { effect: 'limit_min', parameter: 'Tg', value: 55 },
                { effect: 'limit_min', parameter: 'Z', value: 40 }
            ]
        },
        accessibility: {
            name: '♿ Требование доступности',
            desc: 'Экспертиза МГН: повысить безбарьерность и универсальность.',
            effect: 'none',
            params: {},
            actions: [
                { effect: 'limit_min', parameter: 'I', value: 55 },
                { effect: 'limit_min', parameter: 'U', value: 55 }
            ]
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
        {
            id: 'architect',
            name: 'Архитектор',
            desc: 'Вы отстаиваете интересы архитектурного сообщества',
            icon: '🏛️',
            intro: 'Вы представляете профессиональное архитектурное сообщество и смотрите на территорию как на целостный городской проект. Для вас важны качество пространства, логика связей, баланс функций и долгосрочная устойчивость решения. Вы готовы к компромиссам, но не к “лоскутному одеялу” и хаосу.',
            instructions: [
                'Продавите целостную концепцию: связность маршрутов, понятные сценарии, качество пространства.',
                'Поддерживайте функциональное разнообразие и активность там, где это уместно, но требуйте “правил игры”.',
                'Не соглашайтесь на решения, которые ухудшают связность/проницаемость или делают пространство неудобным для повседневности.',
                'Торгуйтесь: готовы уступить в одном, если вам дают качество и связность в другом.',
                'Ваша красная линия: хаотичные, несвязанные меры “лишь бы всем понемногу”.'
            ]
        },
        {
            id: 'activist',
            name: 'Активист',
            desc: 'Вы защищаете права и интересы граждан',
            icon: '📢',
            intro: 'Вы — активный представитель сообщества. Ваша позиция жёсткая: территория должна быть справедливой, доступной и безопасной для всех, а решения — приниматься с участием жителей. Вы готовы спорить и блокировать решения, которые усиливают неравенство или делают среду “не для людей”.',
            instructions: [
                'Прямо требуйте: участие жителей в решениях и приоритет повседневного комфорта.',
                'Ставьте в приоритет безбарьерность и универсальность — “удобно всем, всегда”.',
                'Боритесь с доминированием авто: меньше трафика и лишнего твёрдого покрытия.',
                'Не поддерживайте “коммерцию любой ценой”, если она увеличивает шум, конфликт и вытеснение пользователей.',
                'Ваша красная линия: решения без участия/доступности, даже если “так быстрее”.'
            ]
        },
        {
            id: 'resident',
            name: 'Местный житель',
            desc: 'Вы представляете интересы жителей района',
            icon: '🏠',
            intro: 'Вы — жители ближайших домов и воспринимаете территорию как продолжение своего двора и маршрутов “на каждый день”. Вам нужна спокойная, зелёная, предсказуемая среда без постоянного шума и толп. Вы не против улучшений, но против превращения района в “точку притяжения” за счёт вашего комфорта.',
            instructions: [
                'Жёстко защищайте тишину, порядок и безопасность — это ваш главный приоритет.',
                'Требуйте больше зелени/тени и качественные тротуары: комфорт важнее “аттракционов”.',
                'Сопротивляйтесь решениям, которые создают постоянные скопления людей, шум и “ночную активность”.',
                'Не соглашайтесь на рост трафика и увеличение твёрдого покрытия ради удобства чужих потоков.',
                'Ваша красная линия: шум, толпы и транспортная нагрузка под окнами.'
            ]
        },
        {
            id: 'admin',
            name: 'Чиновник',
            desc: 'Вы представляете интересы городской администрации',
            icon: '🏢',
            intro: 'Вы представляете администрацию и отвечаете за реализуемость. Вам важно, чтобы решение было безопасным, управляемым и предсказуемым: его можно согласовать, построить, обслуживать и контролировать. Вы сдерживаете “радикальные” предложения, которые могут сорвать проект или взорвать конфликт.',
            instructions: [
                'Продавливайте реализуемость: безопасность, нормативность, управляемость и обслуживание.',
                'Сдерживайте крайности — вам нужны устойчивые, контролируемые решения без перегруза территории.',
                'Если интересы конфликтуют — фиксируйте правила и компромиссные рамки, а не обещания “всем всё”.',
                'С осторожностью относитесь к решениям, которые резко повышают активность и конфликтность.',
                'Ваша красная линия: решения, которые невозможно объяснить/согласовать/обслуживать.'
            ]
        },
        {
            id: 'business',
            name: 'Предприниматель',
            desc: 'Вы представляете интересы бизнес-сообщества',
            icon: '💼',
            intro: 'Вы представляете предпринимателей и хотите, чтобы территория была живой и работала: понятные потоки, удобная доступность, функции и точки притяжения. Вам нужна “активная” городская среда, иначе экономика не взлетит. Вы готовы к компромиссам, но не к сценарию “тихо и пусто”.',
            instructions: [
                'Продавите функции и активность: людям должно быть зачем приходить и оставаться.',
                'Поддерживайте активные фасады/первые этажи и удобные маршруты — это даёт поток и безопасность.',
                'Сопротивляйтесь решениям “сделаем максимально тихо и без людей”: это убивает развитие и сервисы.',
                'Торгуйтесь: готовы поддержать озеленение и порядок, если сохраняется жизнеспособная активность.',
                'Ваша красная линия: “спальный режим” без функций, потоков и экономики.'
            ]
        }
    ],
    
    // Команды
    teams: [
        { id: 'a', roleId: 'architect', name: 'Команда Архитекторы', color: '#06d6a0' },
        { id: 'b', roleId: 'activist', name: 'Команда Активисты', color: '#f59e0b' },
        { id: 'c', roleId: 'resident', name: 'Команда Жители', color: '#ec4899' },
        { id: 'd', roleId: 'admin', name: 'Команда Администрация', color: '#8b5cf6' },
        { id: 'e', roleId: 'business', name: 'Команда Предприниматели', color: '#22c55e' }
    ]
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
        completedAt: null,
        protocolSaved: false,
        timers: {}, // { [phase:number]: { startedAt: string|number, durationSec: number } }
        // Настройки проекта
        projectScale: 'medium',
        budgetLevel: 'medium',
        budgetUsed: 0,
        budgetTotal: 120,
        // Снимки состояния для сравнения
        round1Snapshot: null,
        initialSnapshot: null
    },
    
    // Текущий пользователь
    user: {
        id: '',
        name: '',
        isModerator: false,
        isDisplay: false,
        realRole: null,      // Реальная роль участника
        gameRole: null,      // Назначенная игровая роль
        team: null           // Назначенная команда
    },

    // Черновик личного решения участника (локально в этой вкладке).
    // В Firebase сохраняем только подтверждённые снимки: participant.confirmations[phase].
    userDraft: {
        phase: null,       // decisionPhase (1 или 4)
        parameters: [],    // [{id, value}] — личные значения ползунков
        movesPhase: null,  // текущая фаза, для лимита изменений
        movesUsed: []      // список id параметров, которые уже трогали в этой фазе
    },
    
    // Участники сессии
    participants: [],
    
    // Данные команд (для состава команд/капитанов и как fallback, если нет подтверждённых личных решений)
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

    // История событий (для протокола)
    eventsHistory: [],
    
    // Графики
    charts: {
        radar: null,
        timeline: null
    },
    
    // История значений для графиков
    timelineData: [],

    // UI-состояние (локально, не синхронизируем)
    ui: {
        accordionOpen: {} // { [categoryId]: boolean }
    }
};

// =====================================================
// ПРОТОКОЛЫ ИГР (архив)
// =====================================================

const PROTOCOLS_STORAGE_KEY = `${LOCAL_SYNC.storagePrefix}protocols`;

function buildProtocolSnapshot() {
    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        session: {
            code: state.session.code,
            name: state.session.name,
            createdAt: state.session.createdAt ? (state.session.createdAt.toISOString ? state.session.createdAt.toISOString() : state.session.createdAt) : null,
            completedAt: state.session.completedAt ? (state.session.completedAt.toISOString ? state.session.completedAt.toISOString() : state.session.completedAt) : null,
            phase: state.session.phase,
            projectScale: state.session.projectScale,
            budgetLevel: state.session.budgetLevel,
            budgetTotal: state.session.budgetTotal
        },
        participants: state.participants,
        teamsData: state.teamsData,
        log: state.log,
        timelineData: state.timelineData
    };
}

function saveProtocolSnapshot(protocol) {
    if (!protocol?.session?.code) return Promise.reject(new Error('No session code'));
    
    // Firebase
    if (firebaseEnabled) {
        return firebaseDB.ref('protocols').push(protocol);
    }
    
    // Local fallback
    try {
        const raw = localStorage.getItem(PROTOCOLS_STORAGE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        list.push(protocol);
        localStorage.setItem(PROTOCOLS_STORAGE_KEY, JSON.stringify(list));
        return Promise.resolve(true);
    } catch (e) {
        console.error('❌ Protocols: ошибка сохранения локально:', e);
        return Promise.reject(e);
    }
}

function downloadCurrentProtocol() {
    const protocol = buildProtocolSnapshot();
    const stamp = new Date().toISOString().replaceAll(':', '-');
    downloadFile(`protocol_${protocol.session.code}_${stamp}.json`, JSON.stringify(protocol, null, 2));
}

// =====================================================
// ПРОТОКОЛ-ОТЧЁТ (TXT/HTML/PDF)
// =====================================================

function translitRuToLat(str) {
    const map = {
        А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'Zh', З: 'Z', И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'Kh', Ц: 'Ts', Ч: 'Ch', Ш: 'Sh', Щ: 'Sch', Ъ: '', Ы: 'Y', Ь: '', Э: 'E', Ю: 'Yu', Я: 'Ya',
        а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
    };
    return String(str || '').split('').map(ch => (ch in map ? map[ch] : ch)).join('');
}

function buildProtocolReport() {
    const now = new Date();
    const decisionPhase = getLatestDecisionPhase(state.session.phase);
    const activeTeams = getActiveTeams();
    const avg = calculateAverageIGS();
    const conflict = calculateConflict();
    const participants = state.participants.filter(p => !p.isBot);
    const allParams = getAllParameters();
    const defaultById = new Map(allParams.map(p => [p.id, p.default]));

    const teams = activeTeams.map(t => {
        const members = getTeamMembers(t.id).filter(p => !p.isBot);
        const stats = getTeamConfirmationStats(t.id, decisionPhase);
        const igs = calculateTeamIGS(t.id, decisionPhase);
        return {
            id: t.id,
            name: t.name,
            color: t.color,
            members: members.map(m => ({
                id: m.id,
                name: m.name,
                realRole: CONFIG.realRoles[m.realRole]?.name || m.realRole || '-',
                gameRole: m.gameRole?.name || '-',
                isCaptain: !!m.isCaptain,
                confirmed: isParticipantConfirmedForCurrentDecision(m, t.id, decisionPhase),
                confirmationAt: getParticipantConfirmation(m, decisionPhase)?.at || null
            })),
            confirmed: stats,
            igs
        };
    });

    const decisionPhases = Array.from(new Set([1, 4, getLatestDecisionPhase(state.session.phase)]))
        .filter(p => Number.isFinite(Number(p)))
        .map(p => Number(p))
        .sort((a, b) => a - b);

    const decisionsByParticipant = participants.map(p => {
        ensureParticipantMeta(p);
        const byPhase = {};
        decisionPhases.forEach(ph => {
            const rec = getParticipantConfirmation(p, ph);
            const params = (rec?.confirmed && Array.isArray(rec.parameters)) ? rec.parameters : null;
            byPhase[String(ph)] = {
                confirmed: !!rec?.confirmed,
                at: rec?.at || null,
                igs: params ? calculateIGS(params).total : null,
                parameters: params
                    ? allParams.map(def => {
                        const v = params.find(x => x.id === def.id)?.value;
                        const val = (typeof v === 'number') ? v : def.default;
                        const d = Number(defaultById.get(def.id) ?? def.default);
                        return { id: def.id, name: def.name, value: val, default: d, delta: Number(val) - d };
                    })
                    : null
            };
        });
        return {
            id: p.id,
            name: p.name,
            team: p.team?.name || null,
            teamId: p.team?.id || null,
            realRole: CONFIG.realRoles[p.realRole]?.name || p.realRole || '-',
            gameRole: p.gameRole?.name || '-',
            isCaptain: !!p.isCaptain,
            decisions: byPhase
        };
    });

    return {
        version: 1,
        generatedAt: now.toISOString(),
        session: {
            code: state.session.code,
            name: state.session.name,
            phase: state.session.phase,
            phaseName: CONFIG.phases[state.session.phase]?.name || '',
            createdAt: state.session.createdAt ? (state.session.createdAt.toISOString ? state.session.createdAt.toISOString() : state.session.createdAt) : null,
            completedAt: state.session.completedAt ? (state.session.completedAt.toISOString ? state.session.completedAt.toISOString() : state.session.completedAt) : null,
            projectScale: state.session.projectScale,
            budgetLevel: state.session.budgetLevel,
            budgetTotal: state.session.budgetTotal,
            timers: state.session.timers || {}
        },
        summary: {
            teams: activeTeams.length,
            participants: participants.length,
            decisionPhase,
            consensusIGS: avg ? Number(avg.total.toFixed(1)) : null,
            conflictD: Number(conflict.toFixed(1)),
            syncS: (() => {
                const confirmedCount = participants.filter(p => p.team?.id && isParticipantConfirmedForCurrentDecision(p, p.team.id, decisionPhase)).length;
                return participants.length ? Math.round((confirmedCount / participants.length) * 100) : 0;
            })()
        },
        teams,
        conflictTopParams: computeTopConflictingParameters(10),
        conflictTopCategories: Array.from(getConflictingCategoryIds()),
        decisionsByParticipant,
        timeline: state.timelineData || [],
        events: state.eventsHistory || [],
        locks: state.locks || {},
        constraints: state.constraints || {},
        log: state.log || []
    };
}

function buildProtocolText(report) {
    const r = report || buildProtocolReport();
    const lines = [];
    lines.push(`ГОРОДСКОЙ СИМУЛЯТОР — ПРОТОКОЛ`);
    lines.push(`Сессия: ${r.session.name} (${r.session.code})`);
    lines.push(`Фаза: ${r.session.phase} — ${r.session.phaseName}`);
    lines.push(`Дата выгрузки: ${formatDateTime(new Date(r.generatedAt))}`);
    lines.push('');
    lines.push(`Итоги: консенсус ИГС=${r.summary.consensusIGS ?? '—'} | конфликт D=${r.summary.conflictD} | синхронизация=${r.summary.syncS}%`);
    lines.push('');
    r.teams.forEach(t => {
        lines.push(`${t.name}: ИГС=${t.igs.total.toFixed(1)} | подтверждено ${t.confirmed.confirmed}/${t.confirmed.total}`);
        t.members.forEach(m => {
            const mark = m.confirmed ? '✓' : '○';
            const cap = m.isCaptain ? '👑 ' : '';
            lines.push(`  - ${mark} ${cap}${m.name} (${m.realRole} / ${m.gameRole})`);
        });
        lines.push('');
    });
    if (Array.isArray(r.log) && r.log.length) {
        lines.push('Лог:');
        r.log.slice(-200).forEach(e => {
            lines.push(`- ${formatDateTime(new Date(e.time))} [${e.type}] ${e.message}`);
        });
    }
    lines.push('');
    lines.push('Решения участников (таблица: параметр / default / фаза1 / фаза4):');
    (r.decisionsByParticipant || []).forEach(p => {
        lines.push('');
        lines.push(`${p.name} — ${p.team || '-'} (${p.realRole} / ${p.gameRole})`);
        const d1 = p.decisions?.['1'];
        const d4 = p.decisions?.['4'];
        lines.push(`  ИГС ф1: ${d1?.igs ?? '—'} | ИГС ф4: ${d4?.igs ?? '—'}`);
        const params = d1?.parameters || d4?.parameters;
        if (!params) {
            lines.push('  (нет подтверждённых решений)');
            return;
        }
        params.forEach(row => {
            const v1 = d1?.parameters?.find(x => x.id === row.id)?.value;
            const v4 = d4?.parameters?.find(x => x.id === row.id)?.value;
            lines.push(`  - ${row.name}: def=${row.default} | ф1=${(typeof v1 === 'number') ? v1 : '—'} | ф4=${(typeof v4 === 'number') ? v4 : '—'}`);
        });
    });
    return lines.join('\n');
}

function buildProtocolHtml(report) {
    const r = report || buildProtocolReport();
    const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Протокол ${esc(r.session.code)}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;color:#111;background:#fff}
    h1{margin:0 0 8px;font-size:22px}
    .meta{color:#444;margin:0 0 18px}
    .kpi{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 18px}
    .kpi div{border:1px solid #ddd;border-radius:10px;padding:10px 12px}
    table{border-collapse:collapse;width:100%;margin:10px 0 18px}
    th,td{border:1px solid #ddd;padding:8px 10px;font-size:13px;text-align:left;vertical-align:top}
    th{background:#f6f6f6}
    .team{margin:18px 0 6px;font-weight:700}
    .log{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:10px}
    .small{color:#555;font-size:12px}
  </style>
</head>
<body>
  <h1>Городской Симулятор — Протокол</h1>
  <div class="meta">
    <div><b>Сессия:</b> ${esc(r.session.name)} (<b>${esc(r.session.code)}</b>)</div>
    <div><b>Фаза:</b> ${esc(r.session.phase)} — ${esc(r.session.phaseName)}</div>
    <div><b>Дата выгрузки:</b> ${esc(formatDateTime(new Date(r.generatedAt)))}</div>
  </div>
  <div class="kpi">
    <div><b>Консенсус ИГС:</b> ${esc(r.summary.consensusIGS ?? '—')}</div>
    <div><b>Конфликт D:</b> ${esc(r.summary.conflictD)}</div>
    <div><b>Синхронизация:</b> ${esc(r.summary.syncS)}%</div>
  </div>
  ${r.teams.map(t => `
    <div class="team">${esc(t.name)} — ИГС ${esc(t.igs.total.toFixed(1))} • подтверждено ${esc(t.confirmed.confirmed)}/${esc(t.confirmed.total)}</div>
    <table>
      <thead><tr><th>Участник</th><th>Роли</th><th>Статус</th></tr></thead>
      <tbody>
        ${t.members.map(m => `
          <tr>
            <td>${esc(m.name)}${m.isCaptain ? ' 👑' : ''}</td>
            <td>${esc(m.realRole)} / ${esc(m.gameRole)}</td>
            <td>${m.confirmed ? '✓ подтвердил' : '○ не подтвердил'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `).join('')}
  <h2>Решения участников (таблица)</h2>
  <div class="small">Колонки: default / фаза 1 / фаза 4. Если участник не подтвердил фазу — значение “—”.</div>
  ${(r.decisionsByParticipant || []).map(p => {
      const d1 = p.decisions?.['1'];
      const d4 = p.decisions?.['4'];
      const base = d1?.parameters || d4?.parameters || [];
      return `
        <div class="team">${esc(p.name)} — ${esc(p.team || '-')} ${p.isCaptain ? '👑' : ''}</div>
        <div class="small">Роли: ${esc(p.realRole)} / ${esc(p.gameRole)} • ИГС ф1: ${esc(d1?.igs ?? '—')} • ИГС ф4: ${esc(d4?.igs ?? '—')}</div>
        <table>
          <thead><tr><th>Параметр</th><th>Default</th><th>Фаза 1</th><th>Фаза 4</th></tr></thead>
          <tbody>
            ${base.map(row => {
                const v1 = d1?.parameters?.find(x => x.id === row.id)?.value;
                const v4 = d4?.parameters?.find(x => x.id === row.id)?.value;
                return `<tr>
                  <td>${esc(row.name)}</td>
                  <td>${esc(row.default)}</td>
                  <td>${esc((typeof v1 === 'number') ? v1 : '—')}</td>
                  <td>${esc((typeof v4 === 'number') ? v4 : '—')}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      `;
  }).join('')}

  <h2>Динамика (timeline)</h2>
  <table>
    <thead><tr><th>Время</th><th>Фаза</th><th>Консенсус ИГС</th><th>Конфликт D</th></tr></thead>
    <tbody>
      ${(r.timeline || []).slice(-200).map(t => `
        <tr>
          <td>${esc(formatDateTime(new Date(t.time)))}</td>
          <td>${esc(t.phase)}</td>
          <td>${esc(Number(t.consensusIGS ?? 0).toFixed(1))}</td>
          <td>${esc(Number(t.conflict ?? 0).toFixed(1))}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <h2>События</h2>
  ${(r.events || []).length ? `
    <table>
      <thead><tr><th>Время</th><th>Название</th><th>Эффекты</th><th>Изменения</th></tr></thead>
      <tbody>
        ${(r.events || []).map(ev => `
          <tr>
            <td>${esc(formatDateTime(new Date(ev.time)))}</td>
            <td>${esc(ev.name || 'Событие')}</td>
            <td>${esc(ev.effect || 'multi')}</td>
            <td>${esc((ev.impact && ev.impact.length) ? ev.impact.join('; ') : '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : `<div class="small">События не зафиксированы.</div>`}
  <h2>Лог</h2>
  <div class="log">${esc((r.log || []).slice(-200).map(e => `${formatDateTime(new Date(e.time))} [${e.type}] ${e.message}`).join('\n'))}</div>
</body>
</html>`;
}

function downloadProtocolBySessionCode(sessionCode) {
    const code = String(sessionCode || '').trim().toUpperCase();
    if (!code) return Promise.reject(new Error('Empty session code'));
    
    if (!firebaseEnabled) {
        showNotification('Ретро-протокол по коду доступен только в онлайн-режиме (Firebase).', 'error');
        return Promise.reject(new Error('Firebase disabled'));
    }
    
    return firebaseDB.ref(`sessions/${code}`).once('value').then((snap) => {
        const data = snap.val();
        if (!data) {
            showNotification('Сессия не найдена по коду', 'error');
            throw new Error('Session not found');
        }
        
        // Собираем ретро-протокол из того, что реально хранится в sessions/<code>
        const protocol = {
            version: 1,
            type: 'retro',
            fetchedAt: new Date().toISOString(),
            session: {
                code,
                name: data.session?.name || '',
                createdAt: data.session?.createdAt || null,
                completedAt: null,
                phase: typeof data.phase === 'number' ? data.phase : Number(data.phase || 0),
                projectScale: data.session?.projectScale || 'medium',
                budgetLevel: data.session?.budgetLevel || 'medium',
                budgetTotal: data.session?.budgetTotal || null
            },
            participants: data.participants ? Object.values(data.participants) : [],
            teamsData: data.teams || {},
            // В прошлых версиях лог/таймлайн могли не сохраняться в Firebase — оставляем пустыми
            log: [],
            timelineData: []
        };
        
        const stamp = new Date().toISOString().replaceAll(':', '-');
        downloadFile(`protocol_retro_${code}_${stamp}.json`, JSON.stringify(protocol, null, 2));
        return true;
    });
}

function downloadAllProtocols() {
    // Firebase
    if (firebaseEnabled) {
        return firebaseDB.ref('protocols').once('value').then((snap) => {
            const data = snap.val() || {};
            const list = Object.keys(data).map(k => ({ id: k, ...data[k] }));
            list.sort((a, b) => String(b.session?.completedAt || b.exportedAt).localeCompare(String(a.session?.completedAt || a.exportedAt)));
            const stamp = new Date().toISOString().replaceAll(':', '-');
            downloadFile(`protocols_all_${stamp}.json`, JSON.stringify(list, null, 2));
        });
    }
    
    // Local fallback
    try {
        const raw = localStorage.getItem(PROTOCOLS_STORAGE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        if (!list.length) {
            showNotification('Нет сохранённых протоколов (локально)', 'warning');
            return Promise.resolve(false);
        }
        const stamp = new Date().toISOString().replaceAll(':', '-');
        downloadFile(`protocols_all_${stamp}.json`, JSON.stringify(list, null, 2));
        return Promise.resolve(true);
    } catch (e) {
        console.error('❌ Protocols: ошибка чтения локально:', e);
        showNotification('Не удалось прочитать протоколы', 'error');
        return Promise.reject(e);
    }
}

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

function formatDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function parseStartedAtMs(startedAt) {
    if (typeof startedAt === 'number' && Number.isFinite(startedAt)) return startedAt;
    if (typeof startedAt === 'string') {
        const ms = Date.parse(startedAt);
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry(fn, { retries = 5, delayMs = 350 } = {}) {
    let lastErr = null;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            await wait(delayMs);
        }
    }
    throw lastErr;
}

function stddev(values) {
    const xs = (values || []).filter(v => typeof v === 'number' && Number.isFinite(v));
    if (xs.length <= 1) return 0;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
    return Math.sqrt(variance);
}

function getDefaultValuesById() {
    const defs = getAllParameters();
    const map = new Map();
    defs.forEach(p => map.set(p.id, p.default));
    return map;
}

function getMovedParamIds(parameters) {
    const defById = getDefaultValuesById();
    const moved = new Set();
    (parameters || []).forEach(p => {
        const def = defById.get(p.id);
        if (typeof def !== 'number') return;
        if (Number(p.value) !== Number(def)) moved.add(p.id);
    });
    return moved;
}

function getMovedCount(parameters) {
    return getMovedParamIds(parameters).size;
}

function getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function initTooltips() {
    // Кастомные подсказки вместо title (в некоторых браузерах/сборках title не показывается)
    let tip = document.getElementById('app-tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'app-tooltip';
        tip.className = 'app-tooltip hidden';
        document.body.appendChild(tip);
    }

    let activeEl = null;
    const show = (el, text) => {
        if (!text) return;
        activeEl = el;
        tip.textContent = text;
        tip.classList.remove('hidden');
    };
    const hide = () => {
        activeEl = null;
        tip.classList.add('hidden');
    };
    const move = (evt) => {
        if (!activeEl || tip.classList.contains('hidden')) return;
        const pad = 12;
        const x = evt.clientX + pad;
        const y = evt.clientY + pad;
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
    };

    document.addEventListener('mouseover', (e) => {
        const el = e.target?.closest?.('[data-tooltip]');
        if (!el) return;
        const text = el.getAttribute('data-tooltip');
        show(el, text);
    });
    document.addEventListener('mouseout', (e) => {
        const el = e.target?.closest?.('[data-tooltip]');
        if (!el) return;
        if (activeEl === el) hide();
    });
    document.addEventListener('mousemove', move, { passive: true });
}

function $(selector) {
    return document.querySelector(selector);
}

function $$(selector) {
    return document.querySelectorAll(selector);
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

function getDecisionPhaseForUI(phase) {
    return getLatestDecisionPhase(phase);
}

function getDefaultParameterVector() {
    return getAllParameters().map(p => ({ id: p.id, value: p.default }));
}

function cloneParamVector(vec) {
    return JSON.parse(JSON.stringify(Array.isArray(vec) ? vec : []));
}

function getTeamAggregateParameters(teamId, phase) {
    const p = Number.isFinite(Number(phase)) ? Number(phase) : getDecisionPhaseForUI(state.session.phase);
    const teamMembers = getTeamMembers(teamId).filter(x => !x.isBot);
    const confirmed = teamMembers
        .map(m => getParticipantConfirmation(m, p))
        .filter(rec => rec?.confirmed && Array.isArray(rec.parameters) && rec.parameters.length > 0)
        .map(rec => rec.parameters);

    // Если подтверждений нет — fallback на командные параметры (как "базовый" вектор)
    if (confirmed.length === 0) {
        return getTeamData(teamId).parameters;
    }

    const all = getAllParameters();
    return all.map(def => {
        const vals = confirmed
            .map(arr => arr.find(x => x.id === def.id)?.value)
            .filter(v => typeof v === 'number' && Number.isFinite(v));
        const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : def.default;
        return { id: def.id, value: avg };
    });
}

// Расчёт конфликта интересов D (0..50) как среднее стандартное отклонение компонент по командам
function calculateConflict(phase = null) {
    const p = phase === null ? getDecisionPhaseForUI(state.session.phase) : Number(phase);
    const teams = getActiveTeams();
    if (teams.length <= 1) return 0;

    const catIds = CONFIG.parameterCategories.map(c => c.id);
    const perTeamComponents = teams.map(t => {
        const params = getTeamAggregateParameters(t.id, p);
        const comps = {};
        catIds.forEach(cid => { comps[cid] = calculateCategoryValue(cid, params); });
        return comps;
    });

    const spreads = catIds.map(cid => stddev(perTeamComponents.map(c => c[cid])));
    const meanStd = spreads.reduce((a, b) => a + b, 0) / Math.max(1, spreads.length);
    return clamp(meanStd, 0, 50);
}

// Расчёт ИГС для команды (по подтверждённым личным решениям участников)
function calculateTeamIGS(teamId, phase = null) {
    const p = phase === null ? getDecisionPhaseForUI(state.session.phase) : Number(phase);
    const agg = getTeamAggregateParameters(teamId, p);
    return calculateIGS(agg);
}

// Расчёт среднего ИГС по всем командам
function calculateAverageIGS() {
    const activeTeams = getActiveTeams();
    if (activeTeams.length === 0) return null;
    const decisionPhase = getDecisionPhaseForUI(state.session.phase);
    
    // Собираем средние значения параметров
    const allParams = getAllParameters();
    const avgParameters = allParams.map(paramDef => {
        const teamValues = activeTeams.map(team => {
            const params = getTeamAggregateParameters(team.id, decisionPhase);
            const param = params.find(p => p.id === paramDef.id);
            return param ? param.value : paramDef.default;
        });
        return {
            id: paramDef.id,
            value: teamValues.reduce((a, b) => a + b, 0) / teamValues.length
        };
    });
    
    return calculateIGS(avgParameters);
}

function computeTopConflictingParameters(limit = 5) {
    const decisionPhase = getLatestDecisionPhase(state.session.phase);
    const teams = getActiveTeams();
    if (teams.length <= 1) return [];

    const allParams = getAllParameters();
    const byTeam = teams.map(t => ({
        team: t,
        params: getTeamAggregateParameters(t.id, decisionPhase)
    }));

    const scores = allParams.map(def => {
        const teamVals = byTeam
            .map(x => ({ team: x.team, value: x.params.find(p => p.id === def.id)?.value }))
            .filter(x => typeof x.value === 'number' && Number.isFinite(x.value));
        const vals = teamVals.map(x => x.value);
        const sd = stddev(vals);
        const min = vals.length ? Math.min(...vals) : null;
        const max = vals.length ? Math.max(...vals) : null;
        const minTeam = (min === null) ? null : (teamVals.find(x => x.value === min)?.team || null);
        const maxTeam = (max === null) ? null : (teamVals.find(x => x.value === max)?.team || null);
        const spread = (min === null || max === null) ? null : (max - min);
        return { id: def.id, name: def.name, sd, min, max, spread, minTeam, maxTeam };
    });

    scores.sort((a, b) => b.sd - a.sd);
    return scores.slice(0, limit);
}

function getCompromiseTipForParam(paramId) {
    const id = String(paramId || '');
    // Короткие “скрипты модератора”: что на что менять.
    switch (id) {
        case 'N':
        case 'Af':
            return 'Торг: больше функций/оживлённости ↔ гарантии тишины (L) и ниже автотрафик (Tp).';
        case 'L':
            return 'Торг: согласовать минимальный “порог тишины” ↔ разрешить немного активностей (N/Af) в одной зоне/в одно время.';
        case 'Ca':
            return 'Торг: меньше асфальта ↔ лучше связность/маршруты (Pt) и “твёрдые” коридоры только там, где нужно.';
        case 'Tp':
            return 'Торг: ниже автотрафик ↔ компенсировать доступностью: ОТ/пешие связи (M, Pt) и вело (B).';
        case 'As':
            return 'Торг: сильнее участие жителей ↔ фиксированные правила и управляемость (V/O) без “вечных обсуждений”.';
        case 'Z':
        case 'Tg':
            return 'Торг: больше зелени/тени ↔ часть функций (N) допускается, но без роста автотрафика (Tp).';
        default:
            return 'Торг: “встречаемся в середине” + обмен одной уступки на 1–2 приоритетных параметра другой стороны.';
    }
}

function getConflictingCategoryIds() {
    const top = computeTopConflictingParameters(5);
    const byId = new Map(getAllParameters().map(p => [p.id, p.categoryId]));
    const cats = new Set();
    top.forEach(it => {
        const c = byId.get(it.id);
        if (c) cats.add(c);
    });
    return cats;
}

function renderTopConflictParams() {
    const container = $('#conflict-params-list');
    if (!container) return;
    const items = computeTopConflictingParameters(5);
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">—</div>';
        return;
    }
    container.innerHTML = items.map(it => {
        const range = (it.min !== null && it.max !== null) ? `${Math.round(it.min)}–${Math.round(it.max)}` : '—';
        const between = (it.minTeam && it.maxTeam && it.min !== null && it.max !== null)
            ? `${it.minTeam.name}: ${Math.round(it.min)} ↔ ${it.maxTeam.name}: ${Math.round(it.max)}`
            : null;
        return `
            <div class="conflict-param-item" data-tooltip="${it.name}: разброс ${it.sd.toFixed(1)} (диапазон ${range})">
                <div>
                    <div class="conflict-param-name">${it.name}</div>
                    ${between ? `<div class="conflict-param-between">${between}</div>` : ''}
                </div>
                <div class="conflict-param-spread">σ ${it.sd.toFixed(1)}</div>
            </div>
        `;
    }).join('');

    const tips = $('#compromise-hints-list');
    if (tips) {
        tips.innerHTML = items.map(it => {
            const a = it.minTeam?.name || '—';
            const b = it.maxTeam?.name || '—';
            const spread = (it.spread === null) ? '—' : `${Math.round(it.spread)}`;
            const mid = (it.min !== null && it.max !== null) ? Math.round((it.min + it.max) / 2) : null;
            const tip = getCompromiseTipForParam(it.id);
            return `
                <div class="compromise-item">
                    <div class="line1"><b>${it.name}</b>: конфликт ${a} ↔ ${b} (Δ ${spread}${mid !== null ? `, цель ~${mid}` : ''})</div>
                    <div class="line2">${tip}</div>
                </div>
            `;
        }).join('');
    }
}

// =====================================================
// УПРАВЛЕНИЕ КОМАНДАМИ
// =====================================================

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
            // Ревизии решения по фазам (для персональных подтверждений)
            phaseRevisions: {},
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

function getTeamForRealRole(realRoleId) {
    const rid = String(realRoleId || '').trim();
    const t = CONFIG.teams.find(x => x.roleId === rid);
    return t || null;
}

function getLeastFilledTeam() {
    const teamCounts = CONFIG.teams.map(t => ({
        team: t,
        count: state.participants.filter(p => p.team?.id === t.id).length
    }));
    teamCounts.sort((a, b) => a.count - b.count);
    return teamCounts[0]?.team || CONFIG.teams[0];
}

// Проверить, является ли участник капитаном своей команды
function isCaptain(participantId) {
    const participant = state.participants.find(p => p.id === participantId);
    if (!participant || !participant.team) return false;
    
    const teamData = getTeamData(participant.team.id);
    return teamData.captainId === participantId;
}

// Назначить капитана команды (случайно из членов команды)
function assignTeamCaptain(teamId) {
    const teamMembers = state.participants.filter(p => p.team?.id === teamId);
    if (teamMembers.length === 0) return;
    
    const teamData = getTeamData(teamId);
    
    // Если капитан уже есть и он ещё в команде - не меняем
    if (teamData.captainId && teamMembers.find(m => m.id === teamData.captainId)) {
        return;
    }
    
    // Предсказуемое назначение капитана:
    // - если капитана ещё нет, делаем капитаном первого "живого" участника (или первого вообще)
    const humanMembers = teamMembers.filter(p => !p.isBot);
    const captain = (humanMembers[0] || teamMembers[0]);
    teamData.captainId = captain.id;
    // Поддерживаем флаги на участниках (для экспорта/списков)
    teamMembers.forEach(m => { m.isCaptain = (m.id === captain.id); });
    
    addToLog('team', `${captain.name} назначен капитаном ${CONFIG.teams.find(t => t.id === teamId)?.name}`);
}

// Получить участников команды
function getTeamMembers(teamId) {
    return state.participants.filter(p => p.team?.id === teamId);
}

// Получить активные команды (с участниками)
function getActiveTeams() {
    const activeTeamIds = [...new Set(state.participants.map(p => p.team?.id).filter(Boolean))];
    return CONFIG.teams.filter(t => activeTeamIds.includes(t.id));
}

// =====================================================
// УЧАСТНИКИ: подтверждения и снимки решений (персонально)
// =====================================================

function ensureParticipantMeta(p) {
    if (!p || typeof p !== 'object') return p;
    // legacy поля могут отсутствовать у старых участников из Firebase/localStorage
    if (typeof p.confirmed !== 'boolean') p.confirmed = false;
    if (typeof p.confirmedPhase !== 'number') p.confirmedPhase = null;
    if (!p.confirmations || typeof p.confirmations !== 'object') p.confirmations = {};
    // Нормализуем team по текущему CONFIG (чтобы старые сессии не показывали "Команда A/B/...")
    if (p.team && p.team.id) {
        const canonical = CONFIG.teams.find(t => t.id === p.team.id);
        if (canonical) {
            p.team = canonical;
        }
    }
    return p;
}

function syncCaptainFlagsFromTeams() {
    // Держим p.isCaptain в согласованном виде (для списков/экспорта).
    // Источник правды: teamsData[teamId].captainId
    if (!Array.isArray(state.participants)) return;
    state.participants.forEach(p => {
        if (!p?.team?.id) return;
        // Также нормализуем team-объект (имя/цвет) на случай старых данных
        const canonicalTeam = CONFIG.teams.find(t => t.id === p.team.id);
        if (canonicalTeam) p.team = canonicalTeam;
        const capId = state.teamsData?.[p.team.id]?.captainId;
        if (!capId) return;
        p.isCaptain = p.id === capId;
    });
}

function getParticipantById(participantId) {
    const p = state.participants.find(x => x.id === participantId);
    return ensureParticipantMeta(p);
}

function ensureUserDraftInitialized() {
    if (state.user?.isModerator) return;
    const currentPhase = Number(state.session.phase);
    const decisionPhase = getDecisionPhaseForUI(currentPhase);

    // Инициализируем/переключаем черновик при смене decisionPhase (1 ↔ 4)
    if (state.userDraft.phase !== decisionPhase || !Array.isArray(state.userDraft.parameters) || state.userDraft.parameters.length === 0) {
        const me = getParticipantById(state.user.id);
        const rec = me ? getParticipantConfirmation(me, decisionPhase) : null;
        let base = null;
        // Для 2-го раунда (decisionPhase=4) участники принимают решения заново.
        // Поэтому, если раунд 2 ещё не подтверждён, начинаем с дефолтного вектора (а не с итогов раунда 1).
        if (decisionPhase === 4) {
            const rec4 = rec;
            if (rec4?.confirmed && Array.isArray(rec4.parameters) && rec4.parameters.length > 0) {
                base = rec4.parameters;
            }
        } else {
            if (rec?.confirmed && Array.isArray(rec.parameters) && rec.parameters.length > 0) {
                base = rec.parameters;
            }
        }
        if (!base) base = getDefaultParameterVector();

        state.userDraft.phase = decisionPhase;
        state.userDraft.parameters = cloneParamVector(base);
        state.userDraft.movesPhase = null;
        state.userDraft.movesUsed = [];
    }

    // Сбрасываем лимит ходов при смене текущей фазы
    if (state.userDraft.movesPhase !== currentPhase) {
        state.userDraft.movesPhase = currentPhase;
        state.userDraft.movesUsed = [];
    }

    // Гарантируем, что вектор полный (если пришёл старый/неполный снимок)
    const all = getAllParameters();
    const allIds = all.map(p => p.id);
    const defaultsById = new Map(all.map(p => [p.id, p.default]));
    const byId = new Map((state.userDraft.parameters || []).map(x => [x.id, x.value]));
    state.userDraft.parameters = allIds.map(id => ({ id, value: Number(byId.get(id) ?? defaultsById.get(id) ?? 0) }));
}

function getUserDraftParameters() {
    ensureUserDraftInitialized();
    return state.userDraft.parameters;
}

function draftStorageKey(code, participantId, decisionPhase) {
    return `${LOCAL_SYNC.storagePrefix}draft:${String(code || '').toUpperCase()}:${participantId}:${decisionPhase}`;
}

function normalizePersonName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function rejoinPointerKey(code, name) {
    return `${LOCAL_SYNC.storagePrefix}rejoin:${String(code || '').toUpperCase()}:${normalizePersonName(name)}`;
}

function loadRejoinParticipantId(code, name) {
    try {
        return localStorage.getItem(rejoinPointerKey(code, name)) || null;
    } catch {
        return null;
    }
}

function saveRejoinParticipantId(code, name, participantId) {
    try {
        if (!code || !name || !participantId) return;
        localStorage.setItem(rejoinPointerKey(code, name), String(participantId));
    } catch {
        // ignore
    }
}

function getRandomRoleDifferentFrom(roles, disallowId) {
    const list = Array.isArray(roles) ? roles.filter(Boolean) : [];
    if (!list.length) return null;
    if (!disallowId) return list[Math.floor(Math.random() * list.length)];
    const filtered = list.filter(r => String(r.id) !== String(disallowId));
    if (filtered.length) return filtered[Math.floor(Math.random() * filtered.length)];
    return list[Math.floor(Math.random() * list.length)];
}

function saveUserDraftToStorage() {
    try {
        if (state.user.isModerator || state.user.isDisplay) return;
        if (!state.session.code || !state.user.id) return;
        const decisionPhase = getLatestDecisionPhase(state.session.phase);
        const key = draftStorageKey(state.session.code, state.user.id, decisionPhase);
        const payload = {
            savedAt: new Date().toISOString(),
            phase: decisionPhase,
            parameters: getUserDraftParameters(),
            movesPhase: state.userDraft.movesPhase,
            movesUsed: state.userDraft.movesUsed
        };
        localStorage.setItem(key, JSON.stringify(payload));
    } catch (e) {
        console.warn('⚠️ Draft: не удалось сохранить черновик:', e);
    }
}

let draftSaveTimer = null;
function debounceSaveUserDraft(delay = 250) {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(saveUserDraftToStorage, delay);
}

function loadUserDraftFromStorage() {
    try {
        if (state.user.isModerator || state.user.isDisplay) return false;
        if (!state.session.code || !state.user.id) return false;
        const decisionPhase = getLatestDecisionPhase(state.session.phase);
        const key = draftStorageKey(state.session.code, state.user.id, decisionPhase);
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || Number(data.phase) !== Number(decisionPhase) || !Array.isArray(data.parameters)) return false;
        state.userDraft.phase = decisionPhase;
        state.userDraft.parameters = data.parameters;
        state.userDraft.movesPhase = data.movesPhase ?? state.userDraft.movesPhase;
        state.userDraft.movesUsed = Array.isArray(data.movesUsed) ? data.movesUsed : state.userDraft.movesUsed;
        ensureUserDraftInitialized();
        return true;
    } catch (e) {
        console.warn('⚠️ Draft: не удалось восстановить черновик:', e);
        return false;
    }
}

function areParamVectorsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const mapB = new Map(b.map(x => [x.id, x.value]));
    for (const x of a) {
        if (!mapB.has(x.id)) return false;
        if (Number(mapB.get(x.id)) !== Number(x.value)) return false;
    }
    return true;
}

function getTeamPhaseRevision(teamId, phase) {
    const teamData = getTeamData(teamId);
    if (!teamData.phaseRevisions || typeof teamData.phaseRevisions !== 'object') teamData.phaseRevisions = {};
    const key = String(phase);
    const v = Number(teamData.phaseRevisions[key] ?? 0);
    return Number.isFinite(v) ? v : 0;
}

function bumpTeamPhaseRevision(teamId, phase) {
    const teamData = getTeamData(teamId);
    if (!teamData.phaseRevisions || typeof teamData.phaseRevisions !== 'object') teamData.phaseRevisions = {};
    const key = String(phase);
    const prev = Number(teamData.phaseRevisions[key] ?? 0);
    const next = (Number.isFinite(prev) ? prev : 0) + 1;
    teamData.phaseRevisions[key] = next;
    // legacy флаг команды больше не является источником правды
    teamData.confirmed = false;
    return next;
}

function getParticipantConfirmation(p, phase) {
    const pp = ensureParticipantMeta(p);
    if (!pp) return null;
    const rec = pp.confirmations?.[String(phase)];
    return (rec && typeof rec === 'object') ? rec : null;
}

function isParticipantConfirmedForCurrentDecision(p, teamId, phase) {
    const pp = ensureParticipantMeta(p);
    if (!pp || !teamId) return false;
    const rec = getParticipantConfirmation(pp, phase);
    return !!rec?.confirmed;
}

function isParticipantConfirmationStale(p, teamId, phase) {
    const pp = ensureParticipantMeta(p);
    if (!pp || !teamId) return false;
    const rec = getParticipantConfirmation(pp, phase);
    // В новой логике нет "общей ревизии команды": каждый участник подтверждает своё личное решение.
    return false;
}

function getTeamConfirmationStats(teamId, phase) {
    const members = getTeamMembers(teamId).filter(p => !p.isBot);
    const total = members.length;
    const confirmed = members.filter(p => isParticipantConfirmedForCurrentDecision(p, teamId, phase)).length;
    return { confirmed, total };
}

function isTeamDecisionLocked(teamId, phase) {
    // Раньше лочили редактирование капитана, когда все подтвердили общекомандный вектор.
    // Теперь решения личные → командной блокировки нет.
    return false;
}

// =====================================================
// УВЕДОМЛЕНИЯ
// =====================================================

function showNotification(message, type = 'info') {
    const container = $('#notifications');
    const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ'
    };
    
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
    }, 4000);
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
    $('#join-btn').addEventListener('click', () => {
        const joinBtn = $('#join-btn');
        if (joinBtn?.dataset?.busy === '1') return;
        if (joinBtn) {
            joinBtn.dataset.busy = '1';
            joinBtn.disabled = true;
        }
        const code = $('#session-code').value.trim().toUpperCase();
        const name = $('#participant-name').value.trim();
        const realRole = $('#participant-real-role').value;
        
        if (!code || code.length !== 6) {
            showNotification('Введите корректный код сессии (6 символов)', 'error');
            if (joinBtn) { joinBtn.dataset.busy = '0'; joinBtn.disabled = false; }
            return;
        }
        
        if (!name) {
            showNotification('Введите ваше имя', 'error');
            if (joinBtn) { joinBtn.dataset.busy = '0'; joinBtn.disabled = false; }
            return;
        }
        
        if (!realRole) {
            showNotification('Выберите вашу реальную роль', 'error');
            if (joinBtn) { joinBtn.dataset.busy = '0'; joinBtn.disabled = false; }
            return;
        }
        
        showNotification('Подключаюсь к сессии…', 'info');
        joinSession(code, name, realRole)
            .finally(() => {
                if (joinBtn) { joinBtn.dataset.busy = '0'; joinBtn.disabled = false; }
            });
    });
    
    // Создать сессию
    $('#create-btn').addEventListener('click', () => {
        const createBtn = $('#create-btn');
        if (createBtn?.dataset?.busy === '1') return;
        if (createBtn) {
            createBtn.dataset.busy = '1';
            createBtn.disabled = true;
        }
        const sessionName = $('#session-name').value.trim() || 'Новый проект';
        const customCode = $('#session-code-input').value.trim().toUpperCase();
        const moderatorName = $('#moderator-name').value.trim() || 'Модератор';
        
        // Получаем настройки проекта из select
        const projectScale = $('#project-scale')?.value || 'medium';
        const budgetLevel = $('#budget-level')?.value || 'medium';
        
        // Валидация кода, если введён
        if (customCode && !/^[A-Z0-9]{1,6}$/.test(customCode)) {
            showNotification('Код сессии: только латиница и цифры (до 6 символов)', 'error');
            if (createBtn) { createBtn.dataset.busy = '0'; createBtn.disabled = false; }
            return;
        }
        
        showNotification('Создаю сессию…', 'info');
        Promise.resolve(createSession(sessionName, moderatorName, customCode, projectScale, budgetLevel))
            .finally(() => {
                if (createBtn) { createBtn.dataset.busy = '0'; createBtn.disabled = false; }
            });
    });
    
    // Демонстрация: раскрыть/скрыть быстрый ввод кода
    $('#display-btn')?.addEventListener('click', () => {
        const box = $('#display-quick-form');
        if (!box) return;
        box.classList.toggle('hidden');
        if (!box.classList.contains('hidden')) {
            $('#display-session-code')?.focus?.();
        }
    });

    // Режим демонстрации (по коду сессии)
    $('#display-join-btn')?.addEventListener('click', () => {
        const btn = $('#display-join-btn');
        if (btn?.dataset?.busy === '1') return;
        if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
        const code = $('#display-session-code')?.value?.trim()?.toUpperCase();
        if (!code || code.length !== 6) {
            showNotification('Введите корректный код сессии (6 символов)', 'error');
            if (btn) { btn.dataset.busy = '0'; btn.disabled = false; }
            return;
        }
        showNotification('Подключаю режим демонстрации…', 'info');
        joinDisplaySession(code)
            .catch(() => {})
            .finally(() => {
                if (btn) { btn.dataset.busy = '0'; btn.disabled = false; }
            });
    });
}

async function joinDisplaySession(code) {
    const sessionCode = String(code || '').trim().toUpperCase();
    if (!sessionCode || sessionCode.length !== 6) throw new Error('Bad code');

    state.user.id = generateId();
    state.user.name = 'Экран';
    state.user.isModerator = true;   // используем модераторский UI, но отключаем управление
    state.user.isDisplay = true;

    // Загружаем данные сессии
    if (firebaseEnabled) {
        const sessionRef = firebaseDB.ref(`sessions/${sessionCode}`);
        const snap = await retry(async () => (await sessionRef.once('value')).val(), { retries: 8, delayMs: 250 });
        if (!snap) throw new Error('Session not found');

        if (snap.session) {
            const createdAt = snap.session.createdAt ? new Date(snap.session.createdAt) : null;
            const { phase, ...rest } = snap.session;
            state.session = { ...state.session, ...rest, createdAt };
        }
        state.session.code = sessionCode;
        state.session.phase = typeof snap.phase === 'number' ? snap.phase : Number(snap.phase || 0);
        state.session.timers = snap.timers || {};
        // participants/teams подтянутся подпиской, но можно подстраховать
        state.participants = snap.participants ? Object.values(snap.participants).map(p => ensureParticipantMeta(p)) : [];
        state.teamsData = snap.teams || {};
    } else {
        initLocalSync();
        const localSession = localReadSession(sessionCode);
        if (!localSession) throw new Error('Local session not found');
        if (localSession.session) {
            const createdAt = localSession.session.createdAt ? new Date(localSession.session.createdAt) : null;
            state.session = { ...state.session, ...localSession.session, createdAt };
        }
        state.session.code = sessionCode;
        state.session.phase = typeof localSession.phase === 'number' ? localSession.phase : (state.session.phase || 0);
        state.session.timers = localSession.timers || {};
        state.participants = localSession.participants ? Object.values(localSession.participants).map(p => ensureParticipantMeta(p)) : [];
        state.teamsData = localSession.teams || {};
    }

    // Параметры нужны для editor/матриц
    state.parameters = getAllParameters();

    subscribeToSession(sessionCode);
    showScreen('moderator-screen');
    initModeratorScreen();

    // Упрощаем UI: скрываем управляющие кнопки
    document.body.classList.add('display-mode');
    $('#next-phase')?.setAttribute('disabled', 'true');
    $('#pause-btn')?.classList.add('hidden');
    $('#export-menu-btn')?.classList.add('hidden');
    $('#force-confirm-btn')?.classList.add('hidden');
    $('#reset-all-btn')?.classList.add('hidden');
    $('#unlock-all-btn')?.classList.add('hidden');
    $('#add-bot-btn')?.classList.add('hidden');
    showNotification(`Демонстрация подключена: ${sessionCode}`, 'success');
}

async function joinSession(code, name, realRole) {
    console.log('🔄 Попытка входа в сессию:', code);
    
    // Если Firebase включен - сначала проверяем существование сессии
    if (firebaseEnabled) {
        const sessionRef = firebaseDB.ref(`sessions/${code}`);
        try {
            // Retry: сессия может появиться чуть позже (модератор только что нажал "создать")
            const sessionData = await retry(async () => {
                const snapshot = await sessionRef.once('value');
                return snapshot.val();
            }, { retries: 8, delayMs: 250 });
            
            if (!sessionData) {
                showNotification('Сессия не найдена! Проверьте код.', 'error');
                throw new Error('Session not found');
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
            await completeJoinSession(code, name, realRole);
            return true;
        } catch (error) {
            console.error('❌ Ошибка Firebase:', error);
            showNotification('Ошибка подключения. Попробуйте снова.', 'error');
            throw error;
        }
    } else {
        // Без Firebase — подключаемся к локальной сессии (между вкладками)
        initLocalSync();
        const localSession = localReadSession(code);
        if (!localSession) {
            showNotification('Сессия не найдена (локально). Создайте её в другой вкладке или включите Firebase.', 'error');
            throw new Error('Local session not found');
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
        await completeJoinSession(code, name, realRole);
        return true;
    }
}

async function completeJoinSession(code, name, realRole) {
    state.session.code = code;
    state.user.name = name;
    state.user.isModerator = false;
    state.user.realRole = realRole;
    
    // Сначала загружаем существующих участников из Firebase
    if (firebaseEnabled) {
        const sessionRef = firebaseDB.ref(`sessions/${code}`);
        try {
            const snapshot = await sessionRef.child('participants').once('value');
            const existingParticipants = snapshot.val();
            if (existingParticipants) {
                console.log('👥 Загружаю существующих участников перед подключением:', Object.keys(existingParticipants).length);
                state.participants = [];
                Object.values(existingParticipants).forEach(p => {
                    state.participants.push(ensureParticipantMeta(p));
                });
            }
        } catch (e) {
            console.warn('⚠️ Не удалось загрузить список участников перед входом, продолжаю подключение:', e);
        }
    } else {
        // Локальный режим: также подгружаем участников, чтобы работал re-join и равномерное распределение.
        try {
            const localSession = localReadSession(code);
            if (localSession?.participants) {
                state.participants = Object.values(localSession.participants).map(p => ensureParticipantMeta(p));
            }
        } catch (e) {
            console.warn('⚠️ Не удалось загрузить локальных участников перед входом, продолжаю подключение:', e);
        }
    }

    // Если участник уже существует (тот же код + имя) — возвращаем на место (без дублей).
    // 1) Сначала пробуем точное восстановление по сохранённому participantId
    // 2) Потом fallback по имени (если participantId не найден/не совпал)
    const storedParticipantId = loadRejoinParticipantId(code, name);
    const normalizedName = normalizePersonName(name);
    const existingMe =
        (storedParticipantId ? state.participants.find(p => !p.isBot && String(p.id) === String(storedParticipantId)) : null) ||
        state.participants.find(p => !p.isBot && normalizePersonName(p.name) === normalizedName);

    if (existingMe) {
        state.user.id = existingMe.id;
        state.user.team = existingMe.team;
        state.user.gameRole = existingMe.gameRole;
        // Реальная роль — метаданные. При ре-джойне сохраняем исходную реальную роль,
        // чтобы не "перезаписывать" историю из-за выбора на экране входа.
        state.user.realRole = existingMe.realRole || realRole;
        state.user.isCaptain = !!existingMe.isCaptain;

        saveRejoinParticipantId(code, name, existingMe.id);

        // Обновим отметку "жив" (без изменения команды/ролей)
        try {
            existingMe.lastSeenAtMs = Date.now();
            saveParticipantToFirebase(existingMe);
        } catch {
            // ignore
        }

        // Инициализируем параметры/черновик
        state.parameters = getAllParameters();
        ensureUserDraftInitialized();

        subscribeToSession(code);
        showScreen('participant-screen');
        initParticipantScreen();
        showNotification(`Вы вернулись в ${existingMe.team?.name || 'команду'} | Фаза: ${state.session.phase}`, 'success');
        addToLog('join', `${name} вернулся(ась) в сессию → ${existingMe.team?.name || '-'}`);
        console.log('✅ Re-join: участник восстановлен:', existingMe.id);
        return;
    }

    // Новый участник
    state.user.id = generateId();
            // Теперь добавляем себя
        completeJoinSessionStep2(code, name, realRole);
}

function completeJoinSessionStep2(code, name, realRole) {
    // Назначаем игровую роль: случайно и точно ОТЛИЧНУЮ от выбранной реальной роли
    const assignedRole = getRandomRoleDifferentFrom(CONFIG.gameRoles, realRole) || (CONFIG.gameRoles && CONFIG.gameRoles[0]) || { id: 'unknown', name: 'Роль' };
    state.user.gameRole = assignedRole;
    
    // Назначаем команду равномерно (НЕ зависит от выбранной реальной роли),
    // чтобы при любых вводных данные распределялись по командам.
    const assignedTeam = getLeastFilledTeam();
    state.user.team = assignedTeam;
    
    // Инициализируем параметры из новой структуры
    state.parameters = getAllParameters();

    // Инициализируем личный черновик участника
    state.userDraft.phase = null;
    state.userDraft.parameters = [];
    state.userDraft.movesPhase = null;
    state.userDraft.movesUsed = [];
    ensureUserDraftInitialized();
    
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
        isCaptain: false,
        lastSeenAtMs: Date.now(),
        // Персональные подтверждения решений (по фазам)
        confirmed: false,
        confirmedPhase: null,
        confirmations: {}
    };
    state.participants.push(participant);

    saveRejoinParticipantId(code, name, participant.id);
    
    // Назначаем капитана команды
    assignTeamCaptain(assignedTeam.id);
    state.user.isCaptain = participant.isCaptain;
    
    // Подписываемся на обновления сессии
    subscribeToSession(code);
    
    // Сохраняем участника в Firebase
    saveParticipantToFirebase(participant);
    saveTeamToFirebase(assignedTeam.id);
    
    showScreen('participant-screen');
    initParticipantScreen();
    
    const captainMsg = state.user.isCaptain ? ' Вы — капитан команды!' : '';
    const phaseMsg = ` | Фаза: ${state.session.phase}`;
    showNotification(`Вы в ${assignedTeam.name}.${captainMsg}${phaseMsg}`, 'success');
    const rrName = (CONFIG.realRoles && CONFIG.realRoles[realRole] && CONFIG.realRoles[realRole].name) ? CONFIG.realRoles[realRole].name : String(realRole || '-');
    addToLog('join', `${name} (${rrName}) → ${assignedTeam.name}`);
    
    console.log('✅ Участник подключен, текущая фаза:', state.session.phase);
}

async function createSession(sessionName, moderatorName, customCode = '', projectScale = 'medium', budgetLevel = 'medium') {
    console.log('🎬 Создание новой сессии...');
    
    // ⚠️ СБРОС ВСЕХ ДАННЫХ для новой сессии
    state.participants = [];
    state.teamsData = {};
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
    
    // Сохраняем начальное состояние
    state.session.initialSnapshot = JSON.parse(JSON.stringify(state.teamsData));
    
    // Сохраняем в Firebase (и ждём, чтобы участники могли подключаться сразу)
    await saveSessionToFirebase();
    
    // Подписываемся на обновления ПОСЛЕ сохранения
        console.log('📡 Подписываюсь на сессию как модератор');
        subscribeToSession(code);
    
    showScreen('moderator-screen');
    initModeratorScreen();
    
    const scaleInfo = CONFIG.projectScales[projectScale];
    const budgetInfo = CONFIG.budgetLevels[budgetLevel];
    const firebaseStatus = firebaseEnabled ? '☁️ Онлайн' : '💻 Локально';
    showNotification(`Сессия создана! Код: ${code} | ${firebaseStatus}`, 'success');
    addToLog('system', `Проект "${sessionName}" | ${scaleInfo.icon} ${scaleInfo.name} | ${budgetInfo.icon} ${budgetInfo.name}`);
}

// Демо-режим удалён по требованию

// =====================================================
// ЭКРАН УЧАСТНИКА
// =====================================================

function initParticipantScreen() {
    updateParticipantHeader();
    renderRoleCard();
    // Восстановим черновик (если пользователь обновил страницу/случайно вышел)
    loadUserDraftFromStorage();
    renderParameters();
    renderCaptainMatrix();
    renderParticipantInsights();
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

function renderParticipantInsights() {
    if (state.user.isModerator || state.user.isDisplay) return;
    try {
        renderDecisionPassport();
        renderParticipantTeamsRadar();
        renderParticipantConflictBreakdown();
    } catch (e) {
        console.warn('Participant insights render error:', e);
    }
}

function renderRoleCard() {
    const roleCard = $('#role-card');
    const gameRole = state.user.gameRole;
    const team = state.user.team;
    const userIsCaptain = isCaptain(state.user.id);
    
    if (gameRole && team) {
        const captainBadge = userIsCaptain ? ' 👑' : '';
        $('#role-name').textContent = `${gameRole.icon} ${gameRole.name}${captainBadge}`;
        $('#role-desc').textContent = `${gameRole.desc}. Вносите личные изменения и подтверждайте своё решение.`;
        $('#role-team').textContent = team.name + (userIsCaptain ? ' (капитан)' : '');
        $('#role-team').className = `role-team team-${team.id}`;

        const guidanceWrap = $('#role-guidance');
        const introEl = $('#role-intro');
        const listEl = $('#role-instructions');
        const introText = String(gameRole.intro || '').trim();
        const steps = Array.isArray(gameRole.instructions) ? gameRole.instructions.map(s => String(s || '').trim()).filter(Boolean) : [];

        if (guidanceWrap && introEl && listEl) {
            introEl.textContent = introText;
            listEl.innerHTML = '';
            steps.forEach(text => {
                const li = document.createElement('li');
                li.textContent = text;
                listEl.appendChild(li);
            });
            guidanceWrap.classList.toggle('hidden', !introText && steps.length === 0);
        }

        roleCard.classList.remove('hidden');
    } else {
        roleCard.classList.add('hidden');
    }
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
    if (!grid) return;
    grid.innerHTML = '';

    // Аккордеон по категориям
    if (!state.ui || typeof state.ui !== 'object') state.ui = {};
    if (!state.ui.accordionOpen || typeof state.ui.accordionOpen !== 'object') state.ui.accordionOpen = {};
    // Если ничего не открыто (первый рендер / чистый UI) — раскрываем всё,
    // чтобы блок "Параметры проекта" не выглядел пустым.
    if (Object.keys(state.ui.accordionOpen).length === 0) {
        CONFIG.parameterCategories.forEach(cat => { state.ui.accordionOpen[cat.id] = true; });
    }
    
    // Каждый участник меняет ЛИЧНЫЙ черновик (локально)
    const draftParams = getUserDraftParameters();
    const currentPhase = Number(state.session.phase);
    const isInputPhase = (currentPhase === 1 || currentPhase === 4);
    const moveLimit = getMoveLimit();
    // Счётчик изменений = сколько параметров сейчас НЕ на дефолте (а не "сколько трогали")
    const defById = getDefaultValuesById();
    const movedIds = getMovedParamIds(draftParams);
    const movedCount = movedIds.size;
    const movesRemaining = Math.max(0, moveLimit - movedCount);
    
    // Рендерим параметры по категориям
    CONFIG.parameterCategories.forEach(category => {
        const isOpen = !!state.ui.accordionOpen[category.id];

        // Заголовок категории (кликабельный)
        const headerBtn = document.createElement('button');
        headerBtn.type = 'button';
        headerBtn.className = 'param-accordion-header';
        headerBtn.setAttribute('aria-expanded', String(isOpen));
        headerBtn.setAttribute('aria-controls', `acc-body-${category.id}`);
        headerBtn.innerHTML = `
            <span class="category-icon" data-tooltip="${category.name}">${category.icon}</span>
            <span class="category-name">${category.name}</span>
            <span class="category-weight" style="color: ${category.weight < 0 ? '#ef4444' : category.color}">
                ${category.weight > 0 ? '+' : ''}${(category.weight * 100).toFixed(0)}%
            </span>
            <span class="param-accordion-chevron" aria-hidden="true">▾</span>
        `;
        grid.appendChild(headerBtn);

        // Тело аккордеона (в нём лежат карточки-параметры)
        const body = document.createElement('div');
        body.className = 'param-accordion-body';
        body.id = `acc-body-${category.id}`;
        body.hidden = !isOpen;
        // Чтобы карточки встраивались в общий grid (outer grid), а оболочка не ломала сетку
        body.style.display = 'contents';
        grid.appendChild(body);

        headerBtn.addEventListener('click', () => {
            const next = !state.ui.accordionOpen[category.id];
            state.ui.accordionOpen[category.id] = next;
            headerBtn.setAttribute('aria-expanded', String(next));
            body.hidden = !next;
        });
        
        // Параметры категории
        category.params.forEach(param => {
            const isLocked = state.locks[param.id];
            const constraint = state.constraints[param.id] || {};
            const min = constraint.min ?? param.min;
            const max = constraint.max ?? param.max;
            
            // Получаем значение из личного черновика
            const draftParam = draftParams.find(p => p.id === param.id);
            const value = (draftParam && typeof draftParam.value === 'number') ? draftParam.value : param.default;
            const def = Number(defById.get(param.id) ?? param.default);
            const isMoved = Number(value) !== def;
            
            // Ползунок неактивен если заблокирован/не фаза ввода/лимит изменений исчерпан
            const movesExhausted = movesRemaining <= 0;
            const blockedByMoveLimit = movesExhausted && !isMoved;
            const isDisabled = isLocked || !isInputPhase || blockedByMoveLimit;
            
            const card = document.createElement('div');
            card.className = `param-card ${isLocked ? 'locked' : ''} ${isMoved ? 'moved' : ''}`;
            card.style.borderLeftColor = category.color;
            card.innerHTML = `
                <div class="param-header">
                    <span class="param-name">${param.name}</span>
                    <span class="param-value-wrap">
                    <span class="param-value" id="value-${param.id}">${value}${param.unit}</span>
                        <button type="button"
                                class="param-reset-btn"
                                data-param="${param.id}"
                                data-tooltip="Сбросить к дефолту (${def}${param.unit})"
                                ${(!isInputPhase || isLocked || !isMoved) ? 'disabled' : ''}>
                            ↺
                        </button>
                    </span>
                </div>
                <p class="param-desc">${param.desc}</p>
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
                            : (blockedByMoveLimit
                                ? `<div class="param-notice">Лимит изменений на фазу исчерпан (${moveLimit}).</div>`
                        : `<div class="param-notice">Изменено параметров: ${movedCount} / ${moveLimit} • осталось: ${movesRemaining}</div>`)}
            `;
            
            body.appendChild(card);
            
            // Сброс к дефолту (освобождает слот лимита)
            const resetBtn = card.querySelector('.param-reset-btn');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => {
                    const vec = getUserDraftParameters();
                    const entry = vec.find(p => p.id === param.id);
                    if (!entry) return;
                    entry.value = def;

                    const slider = card.querySelector(`#slider-${param.id}`);
                    if (slider) slider.value = String(def);
                    const valEl = card.querySelector(`#value-${param.id}`);
                    if (valEl) valEl.textContent = def + param.unit;

                    updateIGSDisplay();
                    updateConfirmButton();
                    debounceSaveUserDraft();
                    // нужно обновить блокировки/счётчик — теперь можно выбрать другой параметр
                    renderParameters();
                });
            }

            // Обработчик слайдера (каждый участник меняет ЛИЧНЫЙ черновик)
            if (!isLocked && isInputPhase) {
                const slider = card.querySelector(`#slider-${param.id}`);
                slider.addEventListener('input', (e) => {
                    const newValue = parseInt(e.target.value);

                    const limit = getMoveLimit();
                    const vec = getUserDraftParameters();
                    const entry = vec.find(p => p.id === param.id);
                    if (!entry) return;
                    const prevValue = Number(entry.value);

                    const wasMoved = Number(prevValue) !== def;
                    const willBeMoved = Number(newValue) !== def;
                    const currentMovedCount = getMovedCount(vec);
                    if (!wasMoved && willBeMoved && currentMovedCount >= limit) {
                        // Отменяем изменение: возвращаем ползунок к текущему значению
                        e.target.value = String(prevValue);
                        card.querySelector(`#value-${param.id}`).textContent = prevValue + param.unit;
                        showNotification(`Лимит изменений на фазу исчерпан (${limit}).`, 'warning');
                        return;
                    }
                    
                    card.querySelector(`#value-${param.id}`).textContent = newValue + param.unit;
                    
                    // Обновляем личный черновик
                    entry.value = newValue;

                    // Бюджет как "фишки": если бюджета не хватает — откатываем ход
                    const budgetUsedNow = calculateBudgetUsed(vec);
                    if (budgetUsedNow > state.session.budgetTotal) {
                        entry.value = prevValue;
                        e.target.value = String(prevValue);
                        card.querySelector(`#value-${param.id}`).textContent = prevValue + param.unit;
                        showNotification(`Недостаточно бюджета: ${budgetUsedNow} / ${state.session.budgetTotal}. Уменьшите изменения.`, 'warning');
                        updateIGSDisplay();
                        updateConfirmButton();
                        return;
                    }
                    
                    // Обновляем ИГС в реальном времени
                    updateIGSDisplay();
                    updateConfirmButton();
                    debounceSaveUserDraft();
                    
                    // Перерисуем, чтобы заблокировать "лишние" ползунки, когда лимит исчерпан
                    const afterMovedCount = getMovedCount(vec);
                    if (afterMovedCount !== currentMovedCount) renderParameters();
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
    
    const params = getUserDraftParameters();
    if (!params || !igsPanel) return;
    
    const igs = calculateIGS(params);
    
    igsPanel.innerHTML = `
        <div class="igs-main">
            <div class="igs-label">ИГС вашего решения</div>
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
                    <div class="igs-component" data-tooltip="${cat.name}: ${val.toFixed(1)} × ${cat.weight} = ${contribution.toFixed(1)}">
                        <span class="comp-icon">${cat.icon}</span>
                        <span class="comp-value" style="color: ${cat.color}">${val.toFixed(0)}</span>
                    </div>
                `;
            }).join('')}
            <div class="igs-component conflict" data-tooltip="Конфликт интересов: ${igs.components.D.toFixed(1)}">
                <span class="comp-icon">⚡</span>
                <span class="comp-value">${igs.components.D.toFixed(0)}</span>
            </div>
        </div>
    `;
}

// Матрица команд на экране участника
function renderCaptainMatrix() {
    const section = $('#captain-matrix-section');
    const table = $('#captain-params-matrix');
    if (!section || !table) return;

    // По требованию: матрицу параметров видит только модератор
    const show = state.user.isModerator;
    section.classList.toggle('hidden', !show);
    if (!show) return;

    const activeTeams = getActiveTeams();
    const decisionPhase = getLatestDecisionPhase(state.session.phase);

    if (activeTeams.length === 0) {
        table.innerHTML = '<tr><td colspan="100%" style="text-align: center; padding: 1.5rem;">Нет активных команд</td></tr>';
        return;
    }

    let html = '<thead><tr><th>Команда</th>';
    CONFIG.parameterCategories.forEach(cat => {
        html += `<th style="color: ${cat.color}"><span data-tooltip="${cat.name}">${cat.icon}</span></th>`;
    });
    html += '<th title="Индекс Городской Среды">ИГС</th><th>Подтв.</th></tr></thead><tbody>';

    activeTeams.forEach(team => {
        const igs = calculateTeamIGS(team.id);
        const stats = getTeamConfirmationStats(team.id, decisionPhase);
        html += `<tr style="border-left: 4px solid ${team.color}">`;
        html += `<td class="participant-name-cell"><strong>${team.name}</strong></td>`;
        CONFIG.parameterCategories.forEach(cat => {
            const catValue = igs.components[cat.id];
            const colorClass = catValue <= 33 ? 'low' : (catValue <= 66 ? 'mid' : 'high');
            html += `<td class="${colorClass}" data-tooltip="${cat.name}: ${catValue.toFixed(1)}">${catValue.toFixed(0)}</td>`;
        });
        html += `<td class="${getIGSClass(igs.total)}" style="font-weight: bold">${igs.total.toFixed(1)}</td>`;
        html += `<td>${stats.confirmed}/${stats.total}</td>`;
        html += '</tr>';
    });

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
    }

    html += '</tbody>';
    table.innerHTML = html;
}

function getIGSClass(value) {
    if (value >= 70) return 'igs-high';
    if (value >= 40) return 'igs-mid';
    return 'igs-low';
}

function normalizeIGSPercent(igsValue) {
    // В текущей модели практический максимум ≈ 80 (0.20+0.15+0.15+0.15+0.15 = 0.80)
    const pct = (Number(igsValue) / 80) * 100;
    return Math.max(0, Math.min(100, pct));
}

function getIGSGradeText(igsValue) {
    const v = Number(igsValue);
    if (v <= 20) return 'Плохо';
    if (v <= 40) return 'Слабо';
    if (v <= 55) return 'Нормально';
    if (v <= 70) return 'Хорошо';
    return 'Отлично';
}

function normalizeConflictPercent(dValue) {
    // В текущей реализации D обычно 0..50. Нормируем к 0..100 умножением на 2.
    const pct = Number(dValue) * 2;
    return Math.max(0, Math.min(100, pct));
}

function getConflictGradeText(dValue) {
    const v = Number(dValue);
    if (v <= 8) return 'Отлично';
    if (v <= 18) return 'Хорошо';
    if (v <= 30) return 'Средне';
    if (v <= 40) return 'Плохо';
    return 'Очень плохо';
}

// Расчёт использованного бюджета
function calculateBudgetUsed(parameters) {
    let cost = 0;
    const allParams = getAllParameters();
    
    parameters.forEach(p => {
        const paramDef = allParams.find(def => def.id === p.id);
        if (paramDef) {
            const delta = p.value - paramDef.default;
            const paramCost = CONFIG.parameterCosts[p.id] || 10;
            cost += Math.abs(delta) * paramCost / 10;
        }
    });
    
    // Без отрицательного бюджета (даже если какие-то изменения дают "экономию")
    return Math.max(0, Math.round(cost));
}

function getMoveLimit() {
    const base = CONFIG.moveLimitsByBudgetLevel?.[state.session.budgetLevel] ?? 6;
    const adj = CONFIG.moveLimitAdjustByProjectScale?.[state.session.projectScale] ?? 0;
    return Math.max(1, Math.round(Number(base) + Number(adj)));
}

// Обновление Hero-дисплея ИГС (как в En-ROADS)
function updateIGSHero() {
    const heroValue = $('#igs-hero-value');
    const heroFill = $('#igs-hero-fill');
    const budgetDisplay = $('#budget-display');
    const igsHero = $('#igs-hero');
    
    if (!heroValue) return;
    
    const params = getUserDraftParameters();
    if (!params) return;
    
    const igs = calculateIGS(params);
    const budgetUsed = calculateBudgetUsed(params);
    const budgetTotal = state.session.budgetTotal;
    
    heroValue.textContent = igs.total.toFixed(1);
    heroFill.style.width = `${igs.total}%`;
    
    // Класс цвета
    heroValue.className = 'igs-number ' + getIGSClass(igs.total);

    const gradeEl = $('#igs-hero-grade');
    if (gradeEl) {
        const pct = normalizeIGSPercent(igs.total);
        gradeEl.textContent = `${getIGSGradeText(igs.total)} • ${pct.toFixed(0)}% от максимума модели`;
    }
    
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

function getPassportPhase() {
    const preferred = Number(state.ui?.passportPhase);
    if (preferred === 1 || preferred === 4) return preferred;
    const me = getParticipantById(state.user.id);
    const has4 = !!getParticipantConfirmation(me, 4)?.confirmed;
    if (!state.ui || typeof state.ui !== 'object') state.ui = {};
    state.ui.passportPhase = has4 ? 4 : 1;
    return state.ui.passportPhase;
}

function setPassportPhase(phase) {
    const p = Number(phase);
    if (p !== 1 && p !== 4) return;
    if (!state.ui || typeof state.ui !== 'object') state.ui = {};
    state.ui.passportPhase = p;
}

function getBadgeClassForConflictGradeText(text) {
    const t = String(text || '').toLowerCase();
    if (t.includes('отлич')) return 'excellent';
    if (t.includes('хорош')) return 'good';
    if (t.includes('сред')) return 'ok';
    if (t.includes('очень')) return 'terrible';
    if (t.includes('плох')) return 'bad';
    return 'ok';
}

function formatDelta(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v === 0) return '0';
    if (v > 0) return `+${Math.round(v)}`;
    return `${Math.round(v)}`;
}

function computeParamDeltasFromDefault(params) {
    const all = getAllParameters();
    const byId = new Map((params || []).map(p => [p.id, Number(p.value)]));
    return all.map(def => {
        const val = byId.has(def.id) ? byId.get(def.id) : def.default;
        const delta = Number(val) - Number(def.default);
        return {
            id: def.id,
            name: def.name,
            unit: def.unit || '',
            default: Number(def.default),
            value: Number(val),
            delta,
            categoryId: def.categoryId
        };
    }).filter(x => Number.isFinite(x.delta) && x.delta !== 0);
}

function renderDecisionPassport() {
    const tabs = $('#passport-tabs');
    const body = $('#passport-body');
    if (!tabs || !body) return;

    const me = getParticipantById(state.user.id);
    if (!me || !state.user.team?.id) {
        body.innerHTML = `<div class="empty-state-inline">—</div>`;
        return;
    }

    const activePhase = getPassportPhase();
    tabs.querySelectorAll('.segmented-btn').forEach(btn => {
        const p = Number(btn.dataset.phase);
        btn.classList.toggle('active', p === activePhase);
    });
    if (!tabs.dataset.bound) {
        tabs.dataset.bound = '1';
        tabs.addEventListener('click', (e) => {
            const btn = e.target?.closest?.('.segmented-btn');
            if (!btn) return;
            setPassportPhase(btn.dataset.phase);
            renderParticipantInsights();
        });
    }

    const myRec = getParticipantConfirmation(me, activePhase);
    const myParams = (myRec?.confirmed && Array.isArray(myRec.parameters)) ? myRec.parameters : null;
    const teamParams = getTeamAggregateParameters(state.user.team.id, activePhase);

    const D = calculateConflict(activePhase);
    const myIGS = myParams ? calculateIGS(myParams, D) : null;
    const teamIGS = teamParams ? calculateIGS(teamParams, D) : null;

    const far = getMostDistantTeam(state.user.team.id, activePhase);

    const myDeltas = myParams ? computeParamDeltasFromDefault(myParams) : [];
    const teamDeltas = teamParams ? computeParamDeltasFromDefault(teamParams) : [];
    const sortByAbsDeltaDesc = (arr) => (arr || []).sort((a, b) => Math.abs(Number(b.delta)) - Math.abs(Number(a.delta)));
    sortByAbsDeltaDesc(myDeltas);
    sortByAbsDeltaDesc(teamDeltas);

    const myBudgetUsed = calculateBudgetUsed(myParams || getUserDraftParameters());

    const renderDeltaList = (deltas) => {
        if (!deltas.length) return `<div class="empty-state-inline">Нет изменений относительно дефолта</div>`;
        const items = deltas.slice(0, 10);
        const more = deltas.length - items.length;
        const html = items.map(it => {
            const cls = it.delta > 0 ? 'up' : 'down';
            return `
                <div class="delta-item" data-tooltip="${it.name}: ${it.default}${it.unit} → ${it.value}${it.unit}">
                    <div class="name">${it.name}</div>
                    <div class="val"><span class="${cls}">${formatDelta(it.delta)}</span></div>
                </div>
            `;
        }).join('');
        return html + (more > 0 ? `<div class="empty-state-inline">…и ещё ${more}</div>` : '');
    };

    const conflictGrade = getConflictGradeText(D);
    const conflictBadge = getBadgeClassForConflictGradeText(conflictGrade);

    const conflictWithHtml = far?.team
        ? `<div class="passport-conflict-hint">⚡ Конфликт с <b>${far.team.name}</b> • разрыв в <b>${far.maxCat?.name || 'категории'}</b></div>`
        : '';

    body.innerHTML = `
        <div class="passport-col">
            <div class="passport-col-title">
                <div class="label">Моё решение</div>
                <span class="badge ${conflictBadge}" data-tooltip="Конфликт D: ${D.toFixed(1)}">${conflictGrade}</span>
            </div>
            <div class="passport-metrics">
                <span class="metric-chip" data-tooltip="ИГС по вашему подтверждённому решению">
                    ИГС <span class="num">${myIGS ? myIGS.total.toFixed(1) : '—'}</span>
                </span>
                <span class="metric-chip" data-tooltip="Сколько бюджета тратится текущим (подтверждённым) решением; при откате к дефолту бюджет возвращается">
                    💰 Бюджет <span class="num">${myBudgetUsed}</span> / <span class="num">${state.session.budgetTotal}</span>
                </span>
                <span class="metric-chip" data-tooltip="Сколько параметров отличается от дефолта">
                    Изменено <span class="num">${myDeltas.length}</span>
                </span>
            </div>
            ${conflictWithHtml}
            <div class="delta-list">
                ${myParams ? renderDeltaList(myDeltas) : `<div class="empty-state-inline">Подтвердите решение в раунде ${activePhase === 1 ? '1' : '2'}, чтобы появился паспорт</div>`}
            </div>
        </div>
        <div class="passport-col">
            <div class="passport-col-title">
                <div class="label">Решение команды</div>
                <span class="metric-chip" data-tooltip="Агрегат команды по подтверждённым личным решениям участников">агрегат</span>
            </div>
            <div class="passport-metrics">
                <span class="metric-chip" data-tooltip="ИГС по агрегированному решению команды">
                    ИГС <span class="num">${teamIGS ? teamIGS.total.toFixed(1) : '—'}</span>
                </span>
                <span class="metric-chip" data-tooltip="Конфликт (D) между командами в этом раунде">
                    D <span class="num">${D.toFixed(1)}</span>
                </span>
                <span class="metric-chip" data-tooltip="Сколько параметров в агрегате команды отличается от дефолта">
                    Изменено <span class="num">${teamDeltas.length}</span>
                </span>
            </div>
            <div class="delta-list">
                ${renderDeltaList(teamDeltas)}
            </div>
        </div>
    `;
}

function computeTeamCategoryVector(teamId, phase) {
    const params = getTeamAggregateParameters(teamId, phase);
    const vec = {};
    CONFIG.parameterCategories.forEach(cat => {
        vec[cat.id] = calculateCategoryValue(cat.id, params);
    });
    return vec;
}

function teamDistance(aVec, bVec) {
    let sum = 0;
    CONFIG.parameterCategories.forEach(cat => {
        const a = Number(aVec?.[cat.id] ?? 0);
        const b = Number(bVec?.[cat.id] ?? 0);
        sum += Math.abs(a - b);
    });
    return sum;
}

function getMostDistantTeam(myTeamId, phase) {
    const teams = getActiveTeams();
    if (teams.length <= 1) return null;
    const myVec = computeTeamCategoryVector(myTeamId, phase);
    let best = null;
    teams.forEach(t => {
        if (t.id === myTeamId) return;
        const v = computeTeamCategoryVector(t.id, phase);
        const dist = teamDistance(myVec, v);
        if (!best || dist > best.dist) best = { team: t, dist, vec: v, myVec };
    });
    if (!best) return null;
    let maxCat = null;
    let maxAbs = -Infinity;
    CONFIG.parameterCategories.forEach(cat => {
        const d = Math.abs(Number(best.myVec[cat.id]) - Number(best.vec[cat.id]));
        if (d > maxAbs) { maxAbs = d; maxCat = cat; }
    });
    best.maxCat = maxCat;
    best.maxAbs = maxAbs;
    return best;
}

function renderParticipantTeamsRadar() {
    const canvas = $('#participant-radar-canvas');
    const hint = $('#radar-hint');
    const legendEl = $('#radar-legend');
    if (!canvas || !hint) return;
    if (!state.user.team?.id) {
        hint.textContent = '—';
        if (legendEl) legendEl.innerHTML = '';
        return;
    }

    const phase = getDecisionPhaseForUI(state.session.phase);
    const teams = getActiveTeams();
    if (!teams.length) {
        hint.textContent = '—';
        return;
    }

    const labels = CONFIG.parameterCategories.map(c => c.name);
    const myTeamId = state.user.team.id;
    const far = getMostDistantTeam(myTeamId, phase);

    const datasets = teams.map(t => {
        const vec = computeTeamCategoryVector(t.id, phase);
        const data = CONFIG.parameterCategories.map(c => Number(vec[c.id] ?? 0));
        const isMine = t.id === myTeamId;
        const isFar = far?.team?.id === t.id;
        const baseColor = String(t.color || '#3b82f6');
        const border = isMine ? 'rgba(6, 214, 160, 0.95)' : (isFar ? 'rgba(239, 68, 68, 0.9)' : baseColor);
        const width = isMine ? 3 : (isFar ? 3 : 1.5);
        const fill = isMine ? 'rgba(6, 214, 160, 0.08)' : (isFar ? 'rgba(239, 68, 68, 0.06)' : 'rgba(255,255,255,0.02)');
        return {
            label: t.name,
            data,
            borderColor: border,
            backgroundColor: fill,
            borderWidth: width,
            pointRadius: 0,
            tension: 0.2
        };
    });

    // Легенда команд (компактно, все команды сразу)
    if (legendEl) {
        legendEl.innerHTML = '';
        teams.forEach(t => {
            const isMine = t.id === myTeamId;
            const isFar = far?.team?.id === t.id;
            const baseColor = String(t.color || '#3b82f6');

            const pill = document.createElement('span');
            pill.className = `team-pill${isMine ? ' mine' : ''}${isFar ? ' far' : ''}`;
            pill.style.setProperty('--team-color', baseColor);
            if (isFar) {
                pill.setAttribute('data-tooltip', `Самый сильный конфликт: ${t.name} • разрыв в категории ${far?.maxCat?.name || '—'}`);
            } else {
                pill.setAttribute('data-tooltip', t.name);
            }

            const dot = document.createElement('span');
            dot.className = 'dot';

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = t.name;

            pill.appendChild(dot);
            pill.appendChild(name);

            if (isMine) {
                const tag = document.createElement('span');
                tag.className = 'tag';
                tag.textContent = 'вы';
                pill.appendChild(tag);
            }
            if (isFar) {
                const tag = document.createElement('span');
                tag.className = 'tag';
                tag.textContent = 'конфликт';
                pill.appendChild(tag);
            }

            legendEl.appendChild(pill);
        });
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!state.charts) state.charts = {};
    if (state.charts.participantRadar) {
        state.charts.participantRadar.data.labels = labels;
        state.charts.participantRadar.data.datasets = datasets;
        state.charts.participantRadar.update();
    } else {
        state.charts.participantRadar = new Chart(ctx, {
            type: 'radar',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (c) => `${c.dataset.label}: ${Number(c.raw).toFixed(0)}`
                        }
                    }
                },
                scales: {
                    r: {
                        min: 0,
                        max: 100,
                        ticks: { display: false },
                        grid: { color: 'rgba(255,255,255,0.08)' },
                        angleLines: { color: 'rgba(255,255,255,0.08)' },
                        pointLabels: { color: 'rgba(243,244,246,0.85)', font: { size: 11 } }
                    }
                }
            }
        });
    }

    if (far?.team) {
        hint.innerHTML = `Самый сильный конфликт: <b>${far.team.name}</b> • максимальный разрыв в категории <b>${far.maxCat?.name || '—'}</b>`;
    } else {
        hint.textContent = '—';
    }
}

function computeCategorySpreads(phase) {
    const teams = getActiveTeams();
    if (teams.length <= 1) return [];
    const perTeam = teams.map(t => ({
        team: t,
        comps: computeTeamCategoryVector(t.id, phase)
    }));
    return CONFIG.parameterCategories.map(cat => {
        const vals = perTeam.map(x => Number(x.comps[cat.id] ?? 0)).filter(v => Number.isFinite(v));
        const sd = stddev(vals);
        return { cat, sd };
    }).sort((a, b) => b.sd - a.sd);
}

function computeTopConflictingParamInCategory(categoryId, phase) {
    const teams = getActiveTeams();
    if (teams.length <= 1) return null;
    const cat = CONFIG.parameterCategories.find(c => c.id === categoryId);
    if (!cat) return null;
    const byTeam = teams.map(t => ({
        team: t,
        params: getTeamAggregateParameters(t.id, phase)
    }));
    const allParams = getAllParameters();
    const defs = cat.params.map(p => allParams.find(d => d.id === p.id)).filter(Boolean);
    let best = null;
    defs.forEach(def => {
        const vals = byTeam.map(x => x.params.find(p => p.id === def.id)?.value).filter(v => typeof v === 'number' && Number.isFinite(v));
        const sd = stddev(vals);
        const min = vals.length ? Math.min(...vals) : null;
        const max = vals.length ? Math.max(...vals) : null;
        if (!best || sd > best.sd) best = { def, sd, min, max };
    });
    return best;
}

function renderParticipantConflictBreakdown() {
    const summary = $('#conflict-summary');
    const catsEl = $('#conflict-cats');
    if (!summary || !catsEl) return;
    const phase = getDecisionPhaseForUI(state.session.phase);
    const D = calculateConflict(phase);
    const grade = getConflictGradeText(D);
    const badgeCls = getBadgeClassForConflictGradeText(grade);

    summary.innerHTML = `
        <div class="conflict-d">
            <div>Конфликт D</div>
            <div class="num">${D.toFixed(1)}</div>
        </div>
        <span class="badge ${badgeCls}">${grade}</span>
    `;

    const spreads = computeCategorySpreads(phase);
    if (!spreads.length) {
        catsEl.innerHTML = `<div class="empty-state-inline">Недостаточно команд для расчёта конфликта</div>`;
        return;
    }

    catsEl.innerHTML = spreads.slice(0, 6).map(({ cat, sd }) => {
        const g = getConflictGradeText(sd);
        const cls = getBadgeClassForConflictGradeText(g);
        const topParam = computeTopConflictingParamInCategory(cat.id, phase);
        const range = (topParam && topParam.min !== null && topParam.max !== null) ? `${Math.round(topParam.min)}–${Math.round(topParam.max)}` : '—';
        const hint = topParam ? `${topParam.def.name}: σ ${topParam.sd.toFixed(1)} (диапазон ${range})` : '—';
        return `
            <div class="conflict-cat" data-tooltip="${cat.name}: σ ${sd.toFixed(1)} • ${hint}">
                <div class="left">
                    <div class="title"><span>${cat.icon}</span><span>${cat.name}</span></div>
                    <div class="sub">${topParam ? `Самый спорный параметр: ${topParam.def.name} (${range})` : '—'}</div>
                </div>
                <span class="badge ${cls}">σ ${sd.toFixed(1)}</span>
            </div>
        `;
    }).join('');
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
    
    const params = getUserDraftParameters();
    if (!params) return;
    
    // Получаем значения ключевых параметров
    const getParamValue = (id) => {
        const param = params.find(p => p.id === id);
        return param ? param.value : 50;
    };
    
    const greenZones = getParamValue('Z');   // Доля зелёных зон
    const traffic = getParamValue('Tp');     // Трафик
    const hardCover = getParamValue('Ca');   // Твёрдое покрытие
    const lighting = getParamValue('O');     // Освещённость
    const bikePaths = getParamValue('B');    // Велоинфраструктура
    const igsTotal = calculateIGS(params).total;
    
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
    
    const me = getParticipantById(state.user.id);
    if (!me) {
        btn.disabled = true;
        statusEl.textContent = 'Участник не найден';
        return;
    }

    const rec = getParticipantConfirmation(me, currentPhase);
    const draft = getUserDraftParameters();
    const confirmedSameAsDraft = !!(rec?.confirmed && Array.isArray(rec.parameters) && areParamVectorsEqual(rec.parameters, draft));

    // Бюджет как "фишки": нельзя подтвердить, если превышен бюджет
    const budgetUsedNow = calculateBudgetUsed(draft);
    if (budgetUsedNow > state.session.budgetTotal) {
        btn.disabled = true;
        statusEl.textContent = `Превышен бюджет: ${budgetUsedNow} / ${state.session.budgetTotal}. Уменьшите изменения.`;
        return;
    }

    if (confirmedSameAsDraft) {
        btn.disabled = true;
        statusEl.textContent = 'Вы подтвердили решение ✓';
        return;
    }

    btn.disabled = false;
    statusEl.textContent = (rec?.confirmed)
        ? 'Решение изменилось — подтвердите заново'
        : 'Нажмите, чтобы подтвердить своё решение';
}

function confirmDecision() {
    const currentPhase = state.session.phase;
    const isInputPhase = (currentPhase === 1 || currentPhase === 4);
    if (!isInputPhase) {
        showNotification('Подтверждение доступно только в фазах 1 и 4', 'warning');
        return;
    }

    const me = getParticipantById(state.user.id);
    if (!me) return;

    const snapshot = cloneParamVector(getUserDraftParameters());
    const at = new Date().toISOString();

    me.confirmations[String(currentPhase)] = {
        confirmed: true,
        revision: 0,
        at,
        parameters: snapshot
    };
    // legacy флаги для совместимости/быстрого UI
    me.confirmed = true;
    me.confirmedPhase = currentPhase;

    saveParticipantToFirebase(me);

    $('#confirm-status').textContent = 'Вы подтвердили решение ✓';
    $('#confirm-btn').disabled = true;

    // Обновим UI после подтверждения
    renderParameters();
    renderParticipantInsights();
    renderParticipantInsights();

    addToHistory('Подтвердили своё решение');
    addToLog('confirm', `${state.user.name} подтвердил(а) решение (${state.user.team?.name || 'команда'})`);
    showNotification('Ваше решение подтверждено!', 'success');

    console.log(`✅ Участник ${state.user.id} подтвердил ЛИЧНОЕ решение в фазе ${currentPhase}`);
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
    updateModeratorHeader();
    initModeratorTabs();
    initPhaseControls();
    initEventEditor();
    initModeratorActions();
    initExportModal();
    
    // Гарантируем, что видна матрица по умолчанию
    try {
        $$('.mod-tab').forEach(t => t.classList.remove('active'));
        $$('.mod-panel').forEach(p => p.classList.remove('active'));
        const matrixTab = document.querySelector('.mod-tab[data-panel="matrix"]');
        const matrixPanel = $('#panel-matrix');
        if (matrixTab) matrixTab.classList.add('active');
        if (matrixPanel) matrixPanel.classList.add('active');
    } catch (_) {}
    
    renderParticipantsList();
    renderParamsMatrix();
    renderAvgParams();
    initCharts();

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
    if (state.user.isDisplay) return;
    const nextBtn = $('#next-phase');
    const pauseBtn = $('#pause-btn');
    if (!nextBtn || !pauseBtn) return;

    // Идемпотентность: при повторной инициализации не навешиваем обработчики повторно,
    // иначе один клик может сдвигать фазу на +2 и "пропускать" раунд.
    if (nextBtn._csim_onNextPhase) nextBtn.removeEventListener('click', nextBtn._csim_onNextPhase);
    if (pauseBtn._csim_onPause) pauseBtn.removeEventListener('click', pauseBtn._csim_onPause);

    nextBtn._csim_onNextPhase = () => {
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

            // Стартуем таймер на фазах принятия решений
            if (isDecisionTimerPhase(state.session.phase)) {
                startPhaseTimer(state.session.phase, CONFIG.decisionTimers.durationSec);
                // сбрасываем локальное "уведомление об окончании" для этой фазы
                if (state.ui?.timerNotified) state.ui.timerNotified[String(state.session.phase)] = false;
            }
            
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
    };
    nextBtn.addEventListener('click', nextBtn._csim_onNextPhase);
    
    pauseBtn._csim_onPause = () => {
        state.session.isPaused = !state.session.isPaused;
        const btn = pauseBtn;
        
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
    };
    pauseBtn.addEventListener('click', pauseBtn._csim_onPause);
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

    // Таймеры фаз
    updatePhaseTimerUI();
    ensureTimerTicking();

    // Для участника всегда обновляем баннер события + статус кнопки
    // (это исправляет кейс, когда фазу обновил общий listener, а phase-listener не сработал из-за гонки)
    if (!state.user.isModerator) {
        updateEventBanner(phase);
        updateConfirmButton();
    }

    // Экран завершения игры
    if (phase === 5) {
        showEndgameOverlay();
        // Сохраняем протокол только один раз, только у модератора
        if (state.user.isModerator && !state.session.protocolSaved) {
            state.session.completedAt = new Date();
            const protocol = buildProtocolSnapshot();
            saveProtocolSnapshot(protocol)
                .then(() => {
                    state.session.protocolSaved = true;
                    console.log('✅ Protocols: протокол сохранён');
                })
                .catch((e) => {
                    console.error('❌ Protocols: не удалось сохранить протокол:', e);
                });
        }
    }
    
    // Логируем
    console.log(`📍 Фаза ${phase}: ${phaseConfig?.name} — ${phaseConfig?.desc}`);
}

function initEndgameOverlay() {
    const closeBtn = $('#endgame-close');
    if (closeBtn) closeBtn.addEventListener('click', hideEndgameOverlay);

    // Экспорт протокола прямо с табло финала
    $('#endgame-download-html')?.addEventListener('click', () => exportData('html'));
    $('#endgame-download-txt')?.addEventListener('click', () => exportData('txt'));
    $('#endgame-download-json')?.addEventListener('click', () => exportData('json'));
}

function hideEndgameOverlay() {
    const overlay = $('#endgame-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function showEndgameOverlay() {
    const overlay = $('#endgame-overlay');
    const valueEl = $('#endgame-igs-value');
    const sparklineEl = $('#endgame-sparkline');
    const gradeEl = $('#endgame-igs-grade');
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

    if (gradeEl) {
        const pct = normalizeIGSPercent(target);
        gradeEl.textContent = `${getIGSGradeText(target)} • ${pct.toFixed(0)}% от максимума модели`;
    }
    
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
    
    // Личное редактирование: при входе в фазу ввода гарантируем, что черновик и лимиты обновились
    if (!state.user.isModerator) {
        ensureUserDraftInitialized();
    }
    
    // Блокируем/разблокируем ползунки (только для участников)
    if (!state.user.isModerator) {
        // =====================================================
        // ВИЗУАЛЬНЫЙ LAYOUT УЧАСТНИКА ПО ФАЗАМ
        // - Фазы принятия решений (1,4): показываем только ползунки
        // - Фазы обсуждения/анализа (2,3,5): показываем паспорт/радар/конфликт
        // =====================================================
        const insightsSection = $('#insights-section');
        const paramsSection = $('#parameters-section');
        const confirmSection = document.querySelector('.confirm-section');
        const igsPanel = $('#igs-panel'); // создаётся динамически
        const mapSection = document.querySelector('.territory-map-section');

        if (insightsSection) insightsSection.classList.toggle('hidden', isInputPhase);
        if (paramsSection) paramsSection.classList.toggle('hidden', !isInputPhase);
        if (confirmSection) confirmSection.classList.toggle('hidden', !isInputPhase);
        if (igsPanel) igsPanel.classList.toggle('hidden', !isInputPhase);
        if (mapSection) mapSection.classList.toggle('hidden', true); // чтобы в раундах не отвлекало и всё помещалось

        const sliders = $$('.param-card .slider');
        sliders.forEach(slider => {
            slider.disabled = !isInputPhase;
        });
        
        // Визуально показываем статус ползунков
        $$('.param-card').forEach(card => {
            card.classList.toggle('phase-locked', !isInputPhase);
        });
        
        // Кнопка подтверждения (на всякий случай оставляем, но управляем секцией выше)
        const confirmBtn = $('#confirm-btn');
        if (confirmBtn) confirmBtn.style.display = isInputPhase ? 'block' : 'none';
        
        // Обновляем сообщение о статусе фазы
        const confirmStatus = $('#confirm-status');
        if (confirmStatus) {
            confirmStatus.textContent = getPhaseStatusMessage(phase);
        }

        // Обновляем нужный контент при смене режима
        if (isInputPhase) {
            renderParameters();
        } else {
            renderParticipantInsights();
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

function getLatestDecisionPhase(phase) {
    const p = Number(phase);
    if (p >= 5) return 4;
    if (p === 2 || p === 3) return 1;
    return p;
}

// Обновление баннера события для участника
function updateEventBanner(phase) {
    const eventTitle = $('#event-title');
    const eventText = $('#event-text');
    const eventIcon = document.querySelector('#event-banner .event-icon');
    
    if (!eventTitle || !eventText) return;
    
    const phaseInfo = {
        0: { icon: '⏳', title: 'Добро пожаловать!', text: 'Ожидайте начала симуляции от модератора.' },
        1: { icon: '✏️', title: 'Раунд 1: Принятие решений', text: 'Обсудите в команде и настройте параметры проекта. Каждый участник вносит личные предложения.' },
        2: { icon: '📊', title: 'Анализ результатов', text: 'Изучите решения других команд. Обсудите конфликты и точки согласия.' },
        3: { icon: '⚡', title: 'Интермиссия', text: 'Модератор вводит неожиданное событие. Готовьтесь к изменениям!' },
        4: { icon: '🤝', title: 'Раунд 2: Переговоры', text: 'Скорректируйте решения с учётом новых условий и мнений других команд.' },
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
    
    const activeTeams = getActiveTeams();
    const decisionPhase = getLatestDecisionPhase(state.session.phase);
    
    let html = '';
    activeTeams.forEach(team => {
        const teamMembers = getTeamMembers(team.id);
        const teamData = getTeamData(team.id);
        const stats = getTeamConfirmationStats(team.id, decisionPhase);
        
        html += `<div class="team-group" style="border-left: 3px solid ${team.color}; margin-bottom: 1rem; padding-left: 0.75rem;">`;
        html += `<div class="team-group-header" style="font-size: 0.75rem; font-weight: 600; color: ${team.color}; margin-bottom: 0.5rem;">
            ${team.name} (${teamMembers.length}) • подтверждено: ${stats.confirmed}/${stats.total}
        </div>`;
        
        teamMembers.forEach(p => {
            const isCaptainMember = p.id === teamData.captainId;
            const captainBadge = isCaptainMember ? '👑' : '';
            const roleBadge = p.gameRole ? `<span class="participant-role" title="${p.gameRole.name}">${p.gameRole.icon}</span>` : '';
            const ok = isParticipantConfirmedForCurrentDecision(p, team.id, decisionPhase);
            const stale = isParticipantConfirmationStale(p, team.id, decisionPhase);
            const statusMark = ok ? '✓' : (stale ? '↻' : '○');
            const statusText = ok ? 'Подтвердил(а)' : (stale ? 'Нужно подтвердить заново' : 'Не подтвердил(а)');
            
            html += `
                <div class="participant-item" data-id="${p.id}">
                    <div class="participant-avatar ${p.isBot ? 'bot' : ''}" style="border-color: ${team.color}">${getInitials(p.name)}</div>
                    <div class="participant-info">
                        <div class="participant-name">${captainBadge} ${roleBadge} ${p.name} ${p.isBot ? '🤖' : ''}</div>
                        <div class="participant-status">
                            ${isCaptainMember ? 'Капитан' : 'Участник'} • ${statusMark} ${statusText}
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
    const assignedGameRole = availableGameRoles[Math.floor(Math.random() * availableGameRoles.length)];
    
    // Назначаем команду равномерно (НЕ зависит от реальной роли)
    const assignedTeam = getLeastFilledTeam();
    
    // Инициализируем данные команды, если нужно
    initTeamData(assignedTeam.id);
    
    const participant = {
        id: generateId(),
        name: name,
        isBot: isBot,
        realRole: assignedRealRole,
        gameRole: assignedGameRole,
        team: assignedTeam,
        isCaptain: false,
        // Персональные подтверждения решений (по фазам)
        confirmed: false,
        confirmedPhase: null,
        confirmations: {}
    };
    
    state.participants.push(participant);
    
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
    const activeTeams = getActiveTeams();
    const decisionPhase = getLatestDecisionPhase(state.session.phase);
    const conflictCats = getConflictingCategoryIds();
    
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
    let html = '<thead><tr><th>Команда / участник</th>';
    CONFIG.parameterCategories.forEach(cat => {
        const isConflict = conflictCats.has(cat.id);
        const cls = isConflict ? 'conflict-col' : '';
        const tip = isConflict ? `${cat.name} • ⚡ повышенная конфликтность` : cat.name;
        html += `<th class="${cls}" style="color: ${cat.color}"><span data-tooltip="${tip}">${cat.icon}</span></th>`;
    });
    html += '<th title="Индекс Городской Среды">ИГС</th><th>Статус</th></tr></thead><tbody>';
    
    activeTeams.forEach(team => {
        const teamData = getTeamData(team.id);
        const teamMembers = getTeamMembers(team.id);
        const captain = teamMembers.find(m => m.id === teamData.captainId);
        // Строки участников (показываем их личные подтверждённые снимки)
        teamMembers.forEach(p => {
            const isCaptainMember = p.id === teamData.captainId;
            const captainBadge = isCaptainMember ? '👑 ' : '';
            const roleBadge = p.gameRole ? `<span title="${p.gameRole.name}">${p.gameRole.icon}</span> ` : '';
            const ok = isParticipantConfirmedForCurrentDecision(p, team.id, decisionPhase);
            const stale = isParticipantConfirmationStale(p, team.id, decisionPhase);
            const statusMark = ok ? '✓' : (stale ? '↻' : '○');
            
            const rec = getParticipantConfirmation(p, decisionPhase);
            const params = (rec?.confirmed && Array.isArray(rec.parameters)) ? rec.parameters : null;
            const igs = params ? calculateIGS(params) : null;
            
            html += `<tr style="border-left: 4px solid ${team.color}">`;
            html += `<td class="participant-name-cell">
                <div><strong>${team.name}</strong> — ${captainBadge}${roleBadge}${p.name}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted)">
                    фаза ${decisionPhase} • ${isCaptainMember ? 'капитан' : 'участник'}
                </div>
            </td>`;
            
            CONFIG.parameterCategories.forEach(cat => {
                if (!igs) {
                    html += `<td data-tooltip="${cat.name}: нет подтверждённого решения">—</td>`;
                    return;
                }
                const catValue = igs.components[cat.id];
                const colorClass = catValue <= 33 ? 'low' : (catValue <= 66 ? 'mid' : 'high');
                const cc = conflictCats.has(cat.id) ? ' conflict-col' : '';
                html += `<td class="${colorClass}${cc}" data-tooltip="${cat.name}: ${catValue.toFixed(1)}">${catValue.toFixed(0)}</td>`;
            });
            
            if (!igs) {
                html += `<td>—</td>`;
            } else {
                const igsClass = getIGSClass(igs.total);
                html += `<td class="${igsClass}" style="font-weight: bold">${igs.total.toFixed(1)}</td>`;
            }
            
            html += `<td>${statusMark}</td>`;
            html += `</tr>`;
        });
        
        // Агрегированная строка по команде (среднее по подтверждённым актуальным снимкам; иначе текущие параметры команды)
        const eligible = teamMembers
            .filter(p => !p.isBot)
            .filter(p => isParticipantConfirmedForCurrentDecision(p, team.id, decisionPhase))
            .map(p => getParticipantConfirmation(p, decisionPhase)?.parameters)
            .filter(arr => Array.isArray(arr));
        
        let aggParams = null;
        if (eligible.length > 0) {
            const allParams = getAllParameters().map(x => x.id);
            aggParams = allParams.map(id => {
                const vals = eligible.map(ps => ps.find(x => x.id === id)?.value).filter(v => typeof v === 'number');
                const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : (teamData.parameters.find(p => p.id === id)?.value ?? 0);
                return { id, value: avg };
            });
        } else {
            aggParams = teamData.parameters;
        }
        
        const aggIGS = calculateIGS(aggParams);
        const stats = getTeamConfirmationStats(team.id, decisionPhase);
        
        html += `<tr class="team-aggregate-row" style="border-left: 4px solid ${team.color}">`;
        html += `<td class="participant-name-cell">
            <div><strong>${team.name}</strong> — итог команды</div>
            <div style="font-size: 0.75rem; color: var(--text-muted)">
                ${teamMembers.length} уч. | 👑 ${captain?.name || '—'} • подтверждено: ${stats.confirmed}/${stats.total}
            </div>
        </td>`;
        
        CONFIG.parameterCategories.forEach(cat => {
            const catValue = aggIGS.components[cat.id];
            const colorClass = catValue <= 33 ? 'low' : (catValue <= 66 ? 'mid' : 'high');
            const cc = conflictCats.has(cat.id) ? ' conflict-col' : '';
            html += `<td class="${colorClass}${cc}" data-tooltip="${cat.name}: ${catValue.toFixed(1)}">${catValue.toFixed(0)}</td>`;
        });
        
        html += `<td class="${getIGSClass(aggIGS.total)}" style="font-weight: bold">${aggIGS.total.toFixed(1)}</td>`;
        html += `<td>${stats.confirmed}/${stats.total}</td>`;
        html += `</tr>`;
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
    const activeTeams = getActiveTeams();
    
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
    const activeTeams = getActiveTeams();
    
    if (activeTeams.length < 1) {
        $('#metric-d').textContent = '—';
        $('#metric-s').textContent = '—';
        $('#consensus-value').textContent = '—';
        $('#consensus-fill').style.width = '0%';
        const dDesc = $('#metric-d-desc');
        const cDesc = $('#consensus-desc');
        if (dDesc) dDesc.textContent = 'Расхождение команд';
        if (cDesc) cDesc.textContent = '—';
        renderTopConflictParams();
        return;
    }
    
    // Показатель D (конфликт интересов)
    const D = calculateConflict();
    $('#metric-d').textContent = D.toFixed(1);
    const dDesc = $('#metric-d-desc');
    if (dDesc) {
        const pct = normalizeConflictPercent(D);
        dDesc.textContent = `${getConflictGradeText(D)} • ${pct.toFixed(0)}% (норма)`;
    }
    
    // Показатель S (синхронизация) - % подтвердивших участников (актуальное решение последнего раунда)
    const decisionPhase = getLatestDecisionPhase(state.session.phase);
    const participants = state.participants.filter(p => !p.isBot && p.team?.id);
    const confirmedParticipants = participants.filter(p => isParticipantConfirmedForCurrentDecision(p, p.team.id, decisionPhase)).length;
    const S = participants.length > 0 ? Math.round((confirmedParticipants / participants.length) * 100) : 0;
    $('#metric-s').textContent = `${S}%`;
    
    // ИГС консенсуса
    const avgIGS = calculateAverageIGS();
    const igsValue = avgIGS ? avgIGS.total : 0;
    $('#consensus-value').textContent = igsValue.toFixed(1);
    $('#consensus-fill').style.width = `${igsValue}%`;
    const cDesc = $('#consensus-desc');
    if (cDesc) {
        const pct = normalizeIGSPercent(igsValue);
        cDesc.textContent = `${getIGSGradeText(igsValue)} • ${pct.toFixed(0)}% от максимума модели`;
    }

    renderTopConflictParams();
}

// Редактор событий
function initEventEditor() {
    // Шаблоны событий
    $$('.template-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const template = CONFIG.eventTemplates[btn.dataset.template];
            if (template) {
                if (!state.ui || typeof state.ui !== 'object') state.ui = {};
                state.ui.eventDraftActions = Array.isArray(template.actions) ? template.actions : null;
                $('#event-name-input').value = template.name;
                $('#event-desc-input').value = template.desc;
                $('#event-effect-select').value = template.effect || 'none';
                updateEffectParams(template.effect || 'none', template.params || {});
                // Если это сценарий с несколькими эффектами — показываем подсказку
                if (state.ui.eventDraftActions) {
                    $('#event-effect-select').value = 'none';
                    const container = $('#effect-params');
                    if (container) {
                        container.innerHTML = `
                            <div class="input-hint">
                                Этот сценарий применит несколько эффектов (настройки внутри шаблона).
                                При необходимости отредактируйте текст и отправьте.
                            </div>
                        `;
                    }
                }
            }
        });
    });
    
    // Изменение эффекта
    $('#event-effect-select').addEventListener('change', (e) => {
        if (!state.ui || typeof state.ui !== 'object') state.ui = {};
        // Пользователь редактирует эффект руками — снимаем мульти-режим шаблона
        state.ui.eventDraftActions = null;
        updateEffectParams(e.target.value);
    });
    
    // Отправка события
    $('#send-event-btn').addEventListener('click', sendEvent);
}

function updateEffectParams(effect, defaultParams = {}) {
    const container = $('#effect-params');
    
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
    const name = $('#event-name-input').value.trim();
    const desc = $('#event-desc-input').value.trim();
    const effect = $('#event-effect-select').value;
    
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
        actions: null,
        time: new Date()
    };
    
    // Получаем параметры эффекта
    const paramSelect = $('#effect-parameter');
    const valueInput = $('#effect-value');
    
    if (paramSelect) event.params.parameter = paramSelect.value;
    if (valueInput) event.params.value = parseInt(valueInput.value);

    // Если выбран шаблон-сценарий с несколькими эффектами
    if (state.ui?.eventDraftActions && Array.isArray(state.ui.eventDraftActions)) {
        event.effect = 'multi';
        event.actions = state.ui.eventDraftActions.map(a => ({ ...a }));
        event.params = {};
    }
    
    // Применяем эффект
    applyEventEffect(event);

    // Отправляем событие участникам (Firebase / local)
    console.log('📣 sendEvent: отправляю событие участникам', {
        code: state.session.code,
        phase: state.session.phase,
        effect: event.effect,
        params: event.params
    });
    if (!state.session.code) {
        console.warn('⚠️ sendEvent: нет кода сессии');
    } else if (!firebaseEnabled) {
        localBroadcast({ type: 'event', code: state.session.code, event });
    } else {
        try {
            firebaseDB.ref(`sessions/${state.session.code}/events`).push().set(event).then(() => {
                console.log('✅ sendEvent: событие записано в Firebase');
            }).catch((e) => {
                console.error('❌ Ошибка отправки события в Firebase:', e);
                showNotification('Не удалось отправить событие', 'error');
            });
        } catch (e) {
            console.error('❌ Ошибка отправки события в Firebase:', e);
            showNotification('Не удалось отправить событие', 'error');
        }
    }
    
    // Добавляем в лог
    addToLog('event', `Событие: ${name}`);
    showNotification('Событие отправлено участникам', 'success');
    
    // Очищаем форму
    $('#event-name-input').value = '';
    $('#event-desc-input').value = '';
    $('#event-effect-select').value = 'none';
    $('#effect-params').innerHTML = '';
    if (state.ui) state.ui.eventDraftActions = null;
}

function applyEventEffect(event) {
    if (!state.eventsHistory) state.eventsHistory = [];
    const topLevel = !event?._internal;
    const beforeLocks = topLevel ? { ...(state.locks || {}) } : null;
    const beforeConstraints = topLevel ? JSON.parse(JSON.stringify(state.constraints || {})) : null;

    // Мульти-сценарии: применяем набор эффектов
    if (Array.isArray(event.actions) && event.actions.length > 0) {
        event.actions.forEach(a => applyEventEffect({ effect: a.effect, params: a, _internal: true }));
        if (topLevel) {
            const impact = [];
            // diff locks
            const afterLocks = state.locks || {};
            const allLockKeys = new Set([...Object.keys(beforeLocks || {}), ...Object.keys(afterLocks || {})]);
            allLockKeys.forEach(k => {
                const b = beforeLocks?.[k];
                const a = afterLocks?.[k];
                if (b !== a) impact.push(`lock ${k}: ${String(b)} → ${String(a)}`);
            });
            // diff constraints
            const afterConstraints = state.constraints || {};
            const allCKeys = new Set([...Object.keys(beforeConstraints || {}), ...Object.keys(afterConstraints || {})]);
            allCKeys.forEach(k => {
                const b = JSON.stringify(beforeConstraints?.[k] || {});
                const a = JSON.stringify(afterConstraints?.[k] || {});
                if (b !== a) impact.push(`constraint ${k}: ${b} → ${a}`);
            });
            state.eventsHistory.push({
                time: event.time || new Date(),
                name: event.name,
                desc: event.desc,
                effect: 'multi',
                actions: event.actions,
                impact
            });
        }
        return;
    }
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
            // Применяем принудительное значение ко всем командам
            Object.keys(state.teamsData).forEach(teamId => {
                const teamData = state.teamsData[teamId];
                const param = teamData.parameters.find(p => p.id === event.params.parameter);
                if (param) param.value = event.params.value;
            });
            break;
    }

    // Для одиночного события фиксируем влияние
    if (topLevel) {
        const impact = [];
        const afterLocks = state.locks || {};
        const afterConstraints = state.constraints || {};
        if (event.effect === 'lock') impact.push(`lock ${event.params?.parameter} = true`);
        if (event.effect === 'lock_all') impact.push(`lock_all`);
        if (event.effect === 'limit_min') impact.push(`min ${event.params?.parameter} = ${event.params?.value}`);
        if (event.effect === 'limit_max') impact.push(`max ${event.params?.parameter} = ${event.params?.value}`);
        if (event.effect === 'force') impact.push(`force ${event.params?.parameter} = ${event.params?.value}`);

        // плюс дифф общего состояния (на случай кастомного эффекта)
        const allLockKeys = new Set([...Object.keys(beforeLocks || {}), ...Object.keys(afterLocks || {})]);
        allLockKeys.forEach(k => {
            const b = beforeLocks?.[k];
            const a = afterLocks?.[k];
            if (b !== a) impact.push(`lock ${k}: ${String(b)} → ${String(a)}`);
        });
        const allCKeys = new Set([...Object.keys(beforeConstraints || {}), ...Object.keys(afterConstraints || {})]);
        allCKeys.forEach(k => {
            const b = JSON.stringify(beforeConstraints?.[k] || {});
            const a = JSON.stringify(afterConstraints?.[k] || {});
            if (b !== a) impact.push(`constraint ${k}: ${b} → ${a}`);
        });

        state.eventsHistory.push({
            time: event.time || new Date(),
            name: event.name,
            desc: event.desc,
            effect: event.effect,
            params: event.params || {},
            impact
        });
    }
}

// Действия модератора
function initModeratorActions() {
    if (state.user.isDisplay) return;
    // Добавить бота
    $('#add-bot-btn').addEventListener('click', () => {
        const usedNames = state.participants.map(p => p.name);
        const availableNames = CONFIG.botNames.filter(n => !usedNames.includes(n));
        const name = availableNames.length > 0 
            ? availableNames[Math.floor(Math.random() * availableNames.length)]
            : `Бот ${state.participants.length + 1}`;
        
        addParticipant(name, true);
        showNotification(`Бот "${name}" добавлен`, 'info');
    });
    
    // Сбросить параметры
    $('#reset-all-btn').addEventListener('click', () => {
        // Сбрасываем параметры всех команд
        const allParams = getAllParameters();
        Object.keys(state.teamsData).forEach(teamId => {
            const teamData = state.teamsData[teamId];
            teamData.confirmed = false;
            if (!teamData.phaseRevisions || typeof teamData.phaseRevisions !== 'object') teamData.phaseRevisions = {};
            teamData.phaseRevisions['1'] = 0;
            teamData.phaseRevisions['4'] = 0;
            teamData.parameters.forEach(p => {
                const defaultParam = allParams.find(dp => dp.id === p.id);
                p.value = defaultParam ? defaultParam.default : 50;
            });
            saveTeamToFirebase(teamId);
        });
        // Сбрасываем подтверждения участников
        state.participants.forEach(p => {
            ensureParticipantMeta(p);
            p.confirmed = false;
            p.confirmedPhase = null;
            p.confirmations = {};
            saveParticipantToFirebase(p);
        });
        renderParamsMatrix();
        renderAvgParams();
        updateMetrics();
        updateCharts();
        addToLog('action', 'Параметры сброшены к значениям по умолчанию');
        showNotification('Параметры сброшены', 'info');
    });
    
    // Разблокировать всё
    $('#unlock-all-btn').addEventListener('click', () => {
        state.locks = {};
        state.constraints = {};
        addToLog('action', 'Все ограничения сняты');
        showNotification('Все параметры разблокированы', 'info');
    });
    
    // Принять за всех
    $('#force-confirm-btn').addEventListener('click', () => {
        const decisionPhase = getLatestDecisionPhase(state.session.phase);
        state.participants.forEach(p => {
            ensureParticipantMeta(p);
            if (!p.team?.id) return;
            const teamId = p.team.id;
            const teamData = getTeamData(teamId);
            const teamRev = getTeamPhaseRevision(teamId, decisionPhase);
            const snapshot = JSON.parse(JSON.stringify(teamData.parameters || []));
            p.confirmations[String(decisionPhase)] = { confirmed: true, revision: teamRev, at: new Date().toISOString(), parameters: snapshot };
            p.confirmed = true;
            p.confirmedPhase = decisionPhase;
            saveParticipantToFirebase(p);
        });
        renderParticipantsList();
        updateMetrics();
        addToLog('action', 'Решения приняты за всех участников');
        showNotification('Решения подтверждены за всех', 'warning');
    });
    
    // Отправить сообщение
    $('#send-broadcast').addEventListener('click', () => {
        const message = $('#broadcast-message').value.trim();
        if (message) {
            sendBroadcastMessage(message);
            showNotification('Сообщение отправлено', 'success');
            $('#broadcast-message').value = '';
        }
    });
    
    // Очистить лог
    $('#clear-log').addEventListener('click', () => {
        state.log = [];
        renderLog();
    });
    
    // Экспорт лога
    $('#export-log').addEventListener('click', () => {
        const text = state.log.map(e => `[${formatTime(e.time)}] ${e.message}`).join('\n');
        downloadFile('log.txt', text);
    });

    // Скачать протоколы
    $('#download-protocols-btn')?.addEventListener('click', () => {
        const choice = window.prompt(
            'Что скачать?\n\n' +
            '1) ALL — все сохранённые протоколы\n' +
            '2) CURRENT — только текущую игру\n' +
            '3) CODE:<код> — протокол по коду сессии (например CODE:898900)\n\n' +
            'Введите ALL / CURRENT / CODE:... ',
            'CURRENT'
        );
        
        const val = String(choice || '').trim().toUpperCase();
        if (!val) return;
        
        if (val === 'ALL') {
            downloadAllProtocols()
                .then(() => showNotification('Протоколы скачаны', 'success'))
                .catch(() => showNotification('Не удалось скачать протоколы', 'error'));
            return;
        }
        
        if (val.startsWith('CODE:')) {
            const code = val.slice('CODE:'.length).trim();
            downloadProtocolBySessionCode(code)
                .then(() => showNotification(`Протокол по коду ${code} скачан`, 'success'))
                .catch(() => showNotification('Не удалось скачать протокол по коду', 'error'));
            return;
        }
        
        // default: CURRENT
        downloadCurrentProtocol();
        showNotification('Протокол текущей игры скачан', 'success');
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
    
    const activeTeams = getActiveTeams();
    
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
    
    $('#export-menu-btn').addEventListener('click', () => {
        modal.classList.remove('hidden');
    });
    
    modal.querySelector('.modal-close').addEventListener('click', () => {
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
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const report = buildProtocolReport();
    const code = report.session.code || 'SESSION';
    const data = {
        session: state.session,
        parameters: state.parameters,
        participants: state.participants,
        log: state.log,
        exportedAt: new Date().toISOString()
    };
    
    switch (format) {
        case 'json':
            downloadFile(`protocol_${code}_${stamp}.json`, JSON.stringify(report, null, 2), 'application/json;charset=utf-8');
            break;
            
        case 'csv':
            const csv = generateCSV();
            downloadFile(`protocol_${code}_${stamp}.csv`, csv, 'text/csv;charset=utf-8');
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
            generatePDF(report);
            break;

        case 'txt':
            downloadFile(`protocol_${code}_${stamp}.txt`, buildProtocolText(report), 'text/plain;charset=utf-8');
            break;

        case 'html':
            downloadFile(`protocol_${code}_${stamp}.html`, buildProtocolHtml(report), 'text/html;charset=utf-8');
            break;
    }
    
    showNotification(`Данные экспортированы в ${format.toUpperCase()}`, 'success');
}

function generateCSV() {
    // Экспорт по командам с ИГС
    const categories = CONFIG.parameterCategories.map(c => c.name);
    let csv = 'Команда,' + categories.join(',') + ',ИГС,Подтверждено(участники)\n';
    
    const activeTeams = getActiveTeams();
    activeTeams.forEach(team => {
        const igs = calculateTeamIGS(team.id);
        const values = CONFIG.parameterCategories.map(cat => igs.components[cat.id].toFixed(1));
        const stats = getTeamConfirmationStats(team.id, getLatestDecisionPhase(state.session.phase));
        csv += `${team.name},${values.join(',')},${igs.total.toFixed(1)},${stats.confirmed}/${stats.total}\n`;
    });
    
    return csv;
}

function generateXLSX(data) {
    const wb = XLSX.utils.book_new();
    const activeTeams = getActiveTeams();
    
    // Лист с командами и ИГС
    const categories = CONFIG.parameterCategories.map(c => c.name);
    const wsData = [['Команда', ...categories, 'ИГС', 'Конфликт D', 'Подтверждено(участники)']];
    
    activeTeams.forEach(team => {
        const igs = calculateTeamIGS(team.id);
        const row = [team.name];
        CONFIG.parameterCategories.forEach(cat => {
            row.push(igs.components[cat.id].toFixed(1));
        });
        row.push(igs.total.toFixed(1));
        row.push(igs.components.D.toFixed(1));
        const stats = getTeamConfirmationStats(team.id, getLatestDecisionPhase(state.session.phase));
        row.push(`${stats.confirmed}/${stats.total}`);
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

function generatePDF(report) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const r = report || buildProtocolReport();
    const activeTeams = r.teams || [];
    
    // Заголовок
    doc.setFontSize(20);
    // Важно: кириллица без шрифтов в jsPDF отображается некорректно.
    // Делаем транслитерацию, а оригинал отдаём в TXT/HTML.
    doc.text('City Simulation Report (protocol)', 105, 20, { align: 'center' });
    
    doc.setFontSize(12);
    doc.text(`Session: ${translitRuToLat(r.session.name)}`, 20, 35);
    doc.text(`Code: ${r.session.code}`, 20, 42);
    doc.text(`Дата: ${formatDateTime(new Date())}`, 20, 49);
    doc.text(`Teams: ${activeTeams.length} | Participants: ${r.summary.participants}`, 20, 56);
    doc.setFontSize(10);
    doc.text('Note: Cyrillic is available in HTML/TXT exports. This PDF uses transliteration.', 20, 63);
    
    // ИГС Консенсуса
    if (r.summary.consensusIGS !== null) {
        doc.setFontSize(16);
        doc.text(`Consensus IGS: ${Number(r.summary.consensusIGS).toFixed(1)}`, 20, 76);
        doc.text(`Conflict D: ${Number(r.summary.conflictD).toFixed(1)}`, 120, 76);
    }
    
    // Компоненты ИГС
    doc.setFontSize(14);
    doc.text('Teams:', 20, 90);
    
    doc.setFontSize(10);
    let y = 100;
    activeTeams.forEach(team => {
        doc.text(`${translitRuToLat(team.name)}: IGS = ${team.igs.total.toFixed(1)} (confirmed: ${team.confirmed.confirmed}/${team.confirmed.total})`, 25, y);
        y += 6;
    });
    
    // Участники
    doc.setFontSize(14);
    y += 10;
    doc.text('Participants:', 20, y);
    
    doc.setFontSize(10);
    y += 10;
    (r.teams || []).forEach(t => {
        (t.members || []).forEach(p => {
            const captain = p.isCaptain ? ' (captain)' : '';
            doc.text(`${translitRuToLat(p.name)}${captain} - ${translitRuToLat(t.name)}`, 25, y);
        y += 6;
        if (y > 270) {
            doc.addPage();
            y = 20;
        }
        });
    });
    
    doc.save(`protocol_${r.session.code}_${new Date().toISOString().replaceAll(':', '-')}.pdf`);
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
        console.log('📊 Категорий параметров:', CONFIG.parameterCategories.length);
        console.log('👥 Команд:', CONFIG.teams.length);
        
        // Инициализируем Firebase
        initFirebase();
        // Инициализируем подсказки
        initTooltips();
        
        initLoginScreen();
        initEndgameOverlay();
        console.log('✅ Симулятор загружен');
    } catch (error) {
        console.error('❌ Ошибка инициализации:', error);
        alert('Ошибка загрузки приложения: ' + error.message);
    }
});

