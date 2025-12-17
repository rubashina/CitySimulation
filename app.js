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
            
            if (state.user.isModerator) {
                console.log('🔄 Обновляю UI модератора...');
                renderParticipantsList();
                renderParamsMatrix();
                updateMetrics();
                console.log('✅ UI модератора обновлён. Всего участников:', state.participants.length);
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
            teams: existing.teams || {}
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
    timelineData: []
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

// Расчёт ИГС для команды
function calculateTeamIGS(teamId) {
    const teamData = getTeamData(teamId);
    return calculateIGS(teamData.parameters);
}

// Расчёт среднего ИГС по всем командам
function calculateAverageIGS() {
    const activeTeams = getActiveTeams();
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
    const activeTeamIds = [...new Set(state.participants.map(getParticipantTeamId).filter(Boolean))];
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
    
    // Демо-режим
    $('#demo-btn').addEventListener('click', startDemo);
}

function joinSession(code, name, realRole) {
    console.log('🔄 Попытка входа в сессию:', code);
    
    // Если Firebase включен - сначала проверяем существование сессии
    if (firebaseEnabled) {
        const sessionRef = firebaseDB.ref(`sessions/${code}`);
        return sessionRef.once('value').then((snapshot) => {
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
            showNotification('Ошибка подключения. Попробуйте снова.', 'error');
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
    addToLog('join', `${name} (${CONFIG.realRoles[realRole].name}) → ${assignedTeam.name}`);
    
    console.log('✅ Участник подключен, текущая фаза:', state.session.phase);
}

function createSession(sessionName, moderatorName, customCode = '', projectScale = 'medium', budgetLevel = 'medium') {
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
        $('#role-desc').textContent = userIsCaptain 
            ? 'Вы капитан команды! Управляйте ползунками параметров.' 
            : gameRole.desc;
        $('#role-team').textContent = team.name + (userIsCaptain ? ' (капитан)' : '');
        $('#role-team').className = `role-team team-${team.id}`;
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
    grid.innerHTML = '';
    
    // Проверяем, является ли пользователь капитаном
    const userIsCaptain = isCaptain(state.user.id);
    const teamData = state.user.team ? getTeamData(state.user.team.id) : null;
    const currentPhase = Number(state.session.phase);
    const isInputPhase = (currentPhase === 1 || currentPhase === 4);
    const moveLimit = CONFIG.moveLimitsByBudgetLevel?.[state.session.budgetLevel] ?? 6;
    
    // Нормализуем состояние лимита ходов для команды
    if (teamData) {
        if (teamData.movesPhase !== currentPhase) {
            teamData.movesPhase = currentPhase;
            teamData.movesUsed = [];
        }
        if (!Array.isArray(teamData.movesUsed)) teamData.movesUsed = [];
    }
    const movesUsed = teamData?.movesUsed || [];
    const movesRemaining = Math.max(0, moveLimit - movesUsed.length);
    
    // Рендерим параметры по категориям
    CONFIG.parameterCategories.forEach(category => {
        // Заголовок категории
        const categoryHeader = document.createElement('div');
        categoryHeader.className = 'param-category-header';
        categoryHeader.innerHTML = `
            <span class="category-icon">${category.icon}</span>
            <span class="category-name">${category.name}</span>
            <span class="category-weight" style="color: ${category.weight < 0 ? '#ef4444' : category.color}">
                ${category.weight > 0 ? '+' : ''}${(category.weight * 100).toFixed(0)}%
            </span>
        `;
        grid.appendChild(categoryHeader);
        
        // Параметры категории
        category.params.forEach(param => {
            const isLocked = state.locks[param.id];
            const constraint = state.constraints[param.id] || {};
            const min = constraint.min ?? param.min;
            const max = constraint.max ?? param.max;
            
            // Получаем значение из данных команды
            const teamParam = teamData?.parameters.find(p => p.id === param.id);
            const value = teamParam ? teamParam.value : param.default;
            
            // Ползунок неактивен если не капитан или заблокирован
            const alreadyUsedThisPhase = movesUsed.includes(param.id);
            const movesExhausted = movesRemaining <= 0;
            const blockedByMoveLimit = movesExhausted && !alreadyUsedThisPhase;
            const isDisabled = !userIsCaptain || isLocked || !isInputPhase || !!teamData?.confirmed || blockedByMoveLimit;
            
            const card = document.createElement('div');
            card.className = `param-card ${isLocked ? 'locked' : ''} ${!userIsCaptain ? 'readonly' : ''}`;
            card.style.borderLeftColor = category.color;
            card.innerHTML = `
                <div class="param-header">
                    <span class="param-name">${param.name}</span>
                    <span class="param-value" id="value-${param.id}">${value}${param.unit}</span>
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
                ${!userIsCaptain
                    ? '<div class="param-notice">Только капитан может изменять</div>'
                    : (!isInputPhase
                        ? '<div class="param-notice">Изменения доступны только в фазах 1 и 4</div>'
                        : (teamData?.confirmed
                            ? '<div class="param-notice">Решение подтверждено — изменения заблокированы</div>'
                            : (blockedByMoveLimit
                                ? `<div class="param-notice">Лимит изменений на фазу исчерпан (${moveLimit}).</div>`
                                : (movesUsed.length > 0
                                    ? `<div class="param-notice">Осталось изменений: ${movesRemaining} из ${moveLimit}</div>`
                                    : `<div class="param-notice">Доступно изменений: ${moveLimit} за фазу</div>`))))}
            `;
            
            grid.appendChild(card);
            
            // Обработчик слайдера (только для капитана)
            if (userIsCaptain && !isLocked && isInputPhase && !teamData?.confirmed) {
                const slider = card.querySelector(`#slider-${param.id}`);
                slider.addEventListener('input', (e) => {
                    const newValue = parseInt(e.target.value);
                    const teamDataNow = state.user.team ? getTeamData(state.user.team.id) : null;
                    if (!teamDataNow) return;
                    
                    // Если фаза сменилась — сбрасываем счётчик изменений
                    if (teamDataNow.movesPhase !== currentPhase) {
                        teamDataNow.movesPhase = currentPhase;
                        teamDataNow.movesUsed = [];
                    }
                    
                    const used = Array.isArray(teamDataNow.movesUsed) ? teamDataNow.movesUsed : (teamDataNow.movesUsed = []);
                    const alreadyUsed = used.includes(param.id);
                    const limit = CONFIG.moveLimitsByBudgetLevel?.[state.session.budgetLevel] ?? 6;
                    if (!alreadyUsed && used.length >= limit) {
                        // Отменяем изменение: возвращаем ползунок к текущему сохранённому значению
                        const prevValue = teamDataNow.parameters.find(p => p.id === param.id)?.value ?? value;
                        e.target.value = String(prevValue);
                        card.querySelector(`#value-${param.id}`).textContent = prevValue + param.unit;
                        showNotification(`Лимит изменений на фазу исчерпан (${limit}).`, 'warning');
                        return;
                    }
                    if (!alreadyUsed) {
                        used.push(param.id);
                    }
                    
                    card.querySelector(`#value-${param.id}`).textContent = newValue + param.unit;
                    
                    // Обновляем данные команды
                    if (teamDataNow) {
                        const teamParamData = teamDataNow.parameters.find(p => p.id === param.id);
                        if (teamParamData) teamParamData.value = newValue;
                        
                        // Синхронизируем с Firebase (с debounce)
                        debounceSaveTeam(state.user.team.id);
                    }
                    
                    // Обновляем ИГС в реальном времени
                    updateIGSDisplay();
                    updateConfirmButton();
                    
                    // Перерисуем, чтобы заблокировать "лишние" ползунки, когда лимит исчерпан
                    if (!alreadyUsed && used.length >= (CONFIG.moveLimitsByBudgetLevel?.[state.session.budgetLevel] ?? 6)) {
                        renderParameters();
                    }
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
            const paramCost = CONFIG.parameterCosts[p.id] || 10;
            cost += Math.abs(delta) * paramCost / 10;
        }
    });
    
    return Math.round(cost);
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
    // Бюджет как ограничение "ходов": сколько разных ползунков можно тронуть за фазу ввода
    const moveLimit = CONFIG.moveLimitsByBudgetLevel?.[state.session.budgetLevel] ?? 6;
    const currentPhase = Number(state.session.phase);
    const isInputPhase = (currentPhase === 1 || currentPhase === 4);
    const movesUsed = (teamData.movesPhase === currentPhase && Array.isArray(teamData.movesUsed)) ? teamData.movesUsed.length : 0;
    const budgetUsed = isInputPhase ? Math.round((movesUsed / Math.max(1, moveLimit)) * state.session.budgetTotal) : calculateBudgetUsed(teamData.parameters);
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
    
    const userIsCaptain = isCaptain(state.user.id);
    const teamData = state.user.team ? getTeamData(state.user.team.id) : null;
    const currentPhase = state.session.phase;
    
    // Проверяем, активна ли фаза ввода (1 или 4)
    const isInputPhase = (currentPhase === 1 || currentPhase === 4);
    
    if (!isInputPhase) {
        btn.disabled = true;
        statusEl.textContent = getPhaseStatusMessage(currentPhase);
        return;
    }
    
    // Только капитан может подтверждать решение команды
    if (!userIsCaptain) {
        btn.disabled = true;
        statusEl.textContent = 'Только капитан может подтвердить решение команды';
        return;
    }
    
    if (teamData?.confirmed) {
        btn.disabled = true;
        statusEl.textContent = 'Решение команды подтверждено ✓';
        return;
    }
    
    // В фазах ввода капитан может подтвердить как "статус-кво", так и изменения.
    // (это соответствует сценарию: в фазе 1 можно подтвердить решение даже без правок)
    btn.disabled = false;
    
    // Небольшая подсказка, если изменений нет
    const allParams = getAllParameters();
    const hasChanges = teamData?.parameters?.some(p => {
        const defaultParam = allParams.find(dp => dp.id === p.id);
        return defaultParam && p.value !== defaultParam.default;
    }) ?? false;
    statusEl.textContent = hasChanges ? '' : 'Можно подтвердить статус-кво или внесите изменения';
}

function confirmDecision() {
    const userIsCaptain = isCaptain(state.user.id);
    if (!userIsCaptain) {
        showNotification('Только капитан может подтвердить решение', 'error');
        return;
    }
    
    const teamData = state.user.team ? getTeamData(state.user.team.id) : null;
    if (teamData) {
        teamData.confirmed = true;
        
        // Сохраняем в Firebase
        saveTeamToFirebase(state.user.team.id);
    }
    
    $('#confirm-status').textContent = 'Решение команды подтверждено ✓';
    $('#confirm-btn').disabled = true;
    
    // После подтверждения блокируем ползунки (до смены фазы)
    renderParameters();
    
    addToHistory(`Подтвердили решение за ${state.user.team.name}`);
    addToLog('confirm', `${state.user.team.name} подтвердила решение (капитан: ${state.user.name})`);
    showNotification('Решение команды отправлено!', 'success');
    
    console.log(`✅ Команда ${state.user.team.id} подтвердила решение в фазе ${state.session.phase}`);
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
    $('#next-phase').addEventListener('click', () => {
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
    
    $('#pause-btn').addEventListener('click', () => {
        state.session.isPaused = !state.session.isPaused;
        const btn = $('#pause-btn');
        
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
    
    // Сбрасываем подтверждения команд при начале нового раунда ввода
    if (phase === 4) {
        Object.keys(state.teamsData).forEach(teamId => {
            state.teamsData[teamId].confirmed = false;
        });
        console.log('🔄 Сброшены подтверждения команд для Раунда 2');
    }
    
    // Блокируем/разблокируем ползунки (только для участников)
    if (!state.user.isModerator) {
        const sliders = $$('.param-card .slider');
        sliders.forEach(slider => {
            if (!isCaptain(state.user.id)) {
                slider.disabled = true; // Не капитан — всегда заблокирован
            } else {
                slider.disabled = !isInputPhase; // Капитан — только в раундах ввода
            }
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
        1: { icon: '✏️', title: 'Раунд 1: Принятие решений', text: 'Обсудите в команде и настройте параметры проекта. Капитан управляет ползунками.' },
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
    
    let html = '';
    activeTeams.forEach(team => {
        const teamMembers = getTeamMembers(team.id);
        const teamData = getTeamData(team.id);
        
        html += `<div class="team-group" style="border-left: 3px solid ${team.color}; margin-bottom: 1rem; padding-left: 0.75rem;">`;
        html += `<div class="team-group-header" style="font-size: 0.75rem; font-weight: 600; color: ${team.color}; margin-bottom: 0.5rem;">
            ${team.name} (${teamMembers.length}) ${teamData.confirmed ? '✓' : ''}
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
                $('#event-name-input').value = template.name;
                $('#event-desc-input').value = template.desc;
                $('#event-effect-select').value = template.effect;
                updateEffectParams(template.effect, template.params);
            }
        });
    });
    
    // Изменение эффекта
    $('#event-effect-select').addEventListener('change', (e) => {
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
        time: new Date()
    };
    
    // Получаем параметры эффекта
    const paramSelect = $('#effect-parameter');
    const valueInput = $('#effect-value');
    
    if (paramSelect) event.params.parameter = paramSelect.value;
    if (valueInput) event.params.value = parseInt(valueInput.value);
    
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
            // Применяем принудительное значение ко всем командам
            Object.keys(state.teamsData).forEach(teamId => {
                const teamData = state.teamsData[teamId];
                const param = teamData.parameters.find(p => p.id === event.params.parameter);
                if (param) param.value = event.params.value;
            });
            break;
    }
}

// Действия модератора
function initModeratorActions() {
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
            teamData.parameters.forEach(p => {
                const defaultParam = allParams.find(dp => dp.id === p.id);
                p.value = defaultParam ? defaultParam.default : 50;
            });
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
        state.participants.forEach(p => p.confirmed = true);
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
    const data = {
        session: state.session,
        parameters: state.parameters,
        participants: state.participants,
        log: state.log,
        exportedAt: new Date().toISOString()
    };
    
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
            generatePDF(data);
            break;
    }
    
    showNotification(`Данные экспортированы в ${format.toUpperCase()}`, 'success');
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

function generatePDF(data) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const activeTeams = getActiveTeams();
    
    // Заголовок
    doc.setFontSize(20);
    doc.text('Отчёт симуляции ИГС', 105, 20, { align: 'center' });
    
    doc.setFontSize(12);
    doc.text(`Сессия: ${state.session.name}`, 20, 35);
    doc.text(`Код: ${state.session.code}`, 20, 42);
    doc.text(`Дата: ${formatDateTime(new Date())}`, 20, 49);
    doc.text(`Команд: ${activeTeams.length} | Участников: ${state.participants.length}`, 20, 56);
    
    // ИГС Консенсуса
    const avgIGS = calculateAverageIGS();
    if (avgIGS) {
        doc.setFontSize(16);
        doc.text(`ИГС Консенсуса: ${avgIGS.total.toFixed(1)}`, 20, 70);
        doc.text(`Конфликт D: ${calculateConflict().toFixed(1)}`, 120, 70);
    }
    
    // Компоненты ИГС
    doc.setFontSize(14);
    doc.text('Компоненты ИГС по командам:', 20, 85);
    
    doc.setFontSize(10);
    let y = 95;
    activeTeams.forEach(team => {
        const igs = calculateTeamIGS(team.id);
        const teamData = getTeamData(team.id);
        const status = teamData.confirmed ? '✓' : '○';
        doc.text(`${status} ${team.name}: ИГС = ${igs.total.toFixed(1)}`, 25, y);
        y += 6;
    });
    
    // Участники
    doc.setFontSize(14);
    y += 10;
    doc.text('Участники:', 20, y);
    
    doc.setFontSize(10);
    y += 10;
    state.participants.forEach(p => {
        const captain = p.isCaptain ? ' 👑' : '';
        doc.text(`${p.name}${captain} - ${p.team?.name || '-'}`, 25, y);
        y += 6;
        if (y > 270) {
            doc.addPage();
            y = 20;
        }
    });
    
    doc.save('simulation_report.pdf');
}

function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
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
        
        initLoginScreen();
        initEndgameOverlay();
        console.log('✅ Симулятор загружен');
    } catch (error) {
        console.error('❌ Ошибка инициализации:', error);
        alert('Ошибка загрузки приложения: ' + error.message);
    }
});

