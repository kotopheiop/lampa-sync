/**
 * Lampa Sync Plugin
 * @author @kotopheiop
 * @name Lampa Sync
 * @description Синхронизация прогресса, истории и закладок между устройствами
 * @version 1.2.0
 */

(function() {
    'use strict';

    // Проверка на дублирование плагина
    if (window.lampasyncplugin) return;
    window.lampasyncplugin = true;

    // URL этого скрипта — для обновления карточки в списке расширений
    const PLUGIN_SCRIPT_URL = (function () {
        try {
            if (document.currentScript && document.currentScript.src) {
                return String(document.currentScript.src).split('?')[0];
            }
        } catch (_) {}
        try {
            const scripts = Array.from(document.querySelectorAll('script[src]') || []);
            const mine = scripts.find((s) => /lampa-sync|\/plugin\.js/i.test(s.src || ''));
            return mine ? String(mine.src).split('?')[0] : '';
        } catch (_) {}
        return '';
    })();
    // КРИТИЧНО: Очищаем некорректные значения в localStorage ДО инициализации
    // Это исправляет проблему, когда URL сохранился как ключ
    try {
        const storageKeys = Object.keys(localStorage);
        let cleanedCount = 0;
        storageKeys.forEach(key => {
            // Если ключ - это URL (начинается с http), удаляем его
            if (key.startsWith('http://') || key.startsWith('https://')) {
                console.warn('[Lampa Sync] Removing invalid localStorage key (URL):', key);
                localStorage.removeItem(key);
                cleanedCount++;
            }
            // Также проверяем значения - если значение является URL и используется как ключ где-то
            try {
                const value = localStorage.getItem(key);
                if (value && (value.startsWith('http://') || value.startsWith('https://'))) {
                    // Проверяем, не является ли это нашим параметром
                    if (key !== 'lampa_sync_server_url' && key !== 'lampa_sync_password') {
                        // Если значение - URL, но ключ не наш параметр, возможно это ошибка
                        // Но не удаляем, так как это может быть легитимное значение другого плагина
                    }
                }
            } catch (e) {
                // Игнорируем ошибки при проверке значений
            }
        });
        if (cleanedCount > 0) {
            console.log('[Lampa Sync] Cleaned', cleanedCount, 'invalid storage keys');
        }
    } catch (e) {
        console.error('[Lampa Sync] Error cleaning localStorage:', e);
    }
    
    // Дополнительно: очищаем все значения наших параметров, если они некорректны
    try {
        const urlValue = localStorage.getItem('lampa_sync_server_url');
        const passwordValue = localStorage.getItem('lampa_sync_password');
        
        // Если значение - объект (JSON), парсим его
        if (urlValue && urlValue.startsWith('{')) {
            try {
                const parsed = JSON.parse(urlValue);
                if (typeof parsed === 'object' && parsed !== null) {
                    console.warn('[Lampa Sync] URL value is an object, resetting');
                    localStorage.removeItem('lampa_sync_server_url');
                }
            } catch (e) {
                // Не JSON, оставляем как есть
            }
        }
        
        if (passwordValue && passwordValue.startsWith('{')) {
            try {
                const parsed = JSON.parse(passwordValue);
                if (typeof parsed === 'object' && parsed !== null) {
                    console.warn('[Lampa Sync] Password value is an object, resetting');
                    localStorage.removeItem('lampa_sync_password');
                }
            } catch (e) {
                // Не JSON, оставляем как есть
            }
        }
    } catch (e) {
        // Игнорируем ошибки
    }

    // ==================== КОНСТАНТЫ ====================
    const DEBUG = false;
    function log() {
        if (!DEBUG) return;
        try { console.log.apply(console, ['[Lampa Sync]'].concat([].slice.call(arguments))); } catch (_) {}
    }
    let applyingFavorite = false; // глушим pushFavorite при apply с сервера

    const DEFAULT_CONFIG = {
        // Минимальное время для seek (секунды)
        MIN_SEEK_TIME: 60,
        
        // Процент для удаления записи (опционально)
        REMOVE_AT_PERCENT: 95,
        
        // Задержка перед синхронизацией после события (мс)
        SYNC_DELAY: 2000,
        
        // Максимальное время ожидания file_view (мс)
        FILE_VIEW_TIMEOUT: 10000
    };
    
    // ==================== ID УСТРОЙСТВА ====================
    
    /**
     * Генерация уникального ID устройства
     */
    function generateDeviceId() {
        // Генерируем уникальный ID на основе timestamp и случайных чисел
        const timestamp = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substring(2, 15);
        const randomPart2 = Math.random().toString(36).substring(2, 15);
        return `device_${timestamp}_${randomPart}${randomPart2}`;
    }
    
    /**
     * Получение или создание ID устройства
     */
    function getDeviceId() {
        try {
            let deviceId = null;
            
            // Пробуем получить из Lampa.Storage
            if (window.Lampa && window.Lampa.Storage) {
                deviceId = Lampa.Storage.get('lampa_sync_device_id');
            }
            
            // Если нет, пробуем из localStorage
            if (!deviceId) {
                try {
                    deviceId = localStorage.getItem('lampa_sync_device_id');
                } catch (e) {
                    // Игнорируем ошибки
                }
            }
            
            // Если всё ещё нет, создаём новый
            if (!deviceId) {
                deviceId = generateDeviceId();
                console.log('[Lampa Sync] Generated new device ID:', deviceId);
                
                // Сохраняем
                if (window.Lampa && window.Lampa.Storage) {
                    Lampa.Storage.set('lampa_sync_device_id', deviceId);
                } else {
                    try {
                        localStorage.setItem('lampa_sync_device_id', deviceId);
                    } catch (e) {
                        console.error('[Lampa Sync] Error saving device ID:', e);
                    }
                }
            }
            
            return deviceId;
        } catch (e) {
            console.error('[Lampa Sync] Error getting device ID:', e);
            // В случае ошибки возвращаем временный ID
            return generateDeviceId();
        }
    }

    // ==================== КОНФИГУРАЦИЯ ====================
    
    /**
     * Получение конфигурации из настроек Lampa
     */
    /** Проверка, является ли URL localhost/127.0.0.1 */
    function isLocalhostUrl(url) {
        if (!url || typeof url !== 'string') return true;
        return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url.trim());
    }

    /** file:// / Electron / localhost — localhost-сервер OK, CORS с чужого http-домена — нет */
    function isCorsRestrictedOrigin() {
        if (typeof location === 'undefined') return false;
        const proto = location.protocol || '';
        if (proto === 'file:' || proto === 'app:' || proto === 'chrome-extension:') return false;
        const host = location.hostname || '';
        if (!host || host === 'localhost' || host === '127.0.0.1') return false;
        return proto === 'http:' || proto === 'https:';
    }

    // Сразу после сохранения в модалке используем этот URL/пароль, чтобы не тянуть localhost из Lampa.Storage
    let lastSavedServerUrl = null;
    let lastSavedPassword = null;

    function getConfig() {
        if (lastSavedServerUrl !== null && lastSavedPassword !== null) {
            return {
                SYNC_SERVER_URL: String(lastSavedServerUrl).trim(),
                SYNC_PASSWORD: String(lastSavedPassword).trim(),
                MIN_SEEK_TIME: DEFAULT_CONFIG.MIN_SEEK_TIME,
                REMOVE_AT_PERCENT: DEFAULT_CONFIG.REMOVE_AT_PERCENT,
                SYNC_DELAY: DEFAULT_CONFIG.SYNC_DELAY,
                FILE_VIEW_TIMEOUT: DEFAULT_CONFIG.FILE_VIEW_TIMEOUT
            };
        }

        let serverUrl = 'http://localhost:3000';
        let password = '';
        let urlFromStorage = null;
        let urlFromLampa = null;

        try {
            const storedUrl = localStorage.getItem('lampa_sync_server_url');
            const storedPassword = localStorage.getItem('lampa_sync_password');
            if (storedUrl && typeof storedUrl === 'string') urlFromStorage = storedUrl.trim();
            if (storedPassword && typeof storedPassword === 'string') password = storedPassword;
        } catch (e) {}

        if (window.Lampa && window.Lampa.Storage) {
            try {
                let u = null, p = null;
                if (typeof Lampa.Storage.field === 'function') {
                    u = Lampa.Storage.field('lampa_sync_server_url');
                    p = Lampa.Storage.field('lampa_sync_password');
                } else {
                    u = Lampa.Storage.get('lampa_sync_server_url');
                    p = Lampa.Storage.get('lampa_sync_password');
                }
                if (u && typeof u === 'string') urlFromLampa = u.trim();
                if (p && typeof p === 'string') password = (p || password || '').trim();
            } catch (e) {}
        }

        const preferLocalhost = (a, b) => {
            const aLocal = isLocalhostUrl(a);
            const bLocal = isLocalhostUrl(b);
            if (!aLocal && bLocal) return a;
            if (aLocal && !bLocal) return b;
            return b || a || 'http://localhost:3000';
        };
        serverUrl = preferLocalhost(urlFromStorage, urlFromLampa) || urlFromStorage || urlFromLampa || 'http://localhost:3000';

        serverUrl = String(serverUrl || 'http://localhost:3000').trim();
        password = String(password || '').trim();
        
        return {
            SYNC_SERVER_URL: serverUrl,
            SYNC_PASSWORD: password,
            MIN_SEEK_TIME: DEFAULT_CONFIG.MIN_SEEK_TIME,
            REMOVE_AT_PERCENT: DEFAULT_CONFIG.REMOVE_AT_PERCENT,
            SYNC_DELAY: DEFAULT_CONFIG.SYNC_DELAY,
            FILE_VIEW_TIMEOUT: DEFAULT_CONFIG.FILE_VIEW_TIMEOUT
        };
    }

    // ==================== УТИЛИТЫ ====================
    
    /**
     * Получение значения из Storage Lampa или localStorage
     */
    function getStorage(key, defaultValue = null) {
        try {
            if (window.Lampa && Lampa.Storage && typeof Lampa.Storage.get === 'function') {
                const v = Lampa.Storage.get(key, defaultValue == null ? '' : defaultValue);
                if (v === '' || v == null) return defaultValue;
                return v;
            }
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : defaultValue;
        } catch (e) {
            console.error('[Lampa Sync] Error reading storage:', e);
            return defaultValue;
        }
    }

    /**
     * Сохранение значения в Storage Lampa (с кэшем) или в localStorage
     */
    function setStorage(key, value) {
        try {
            // Важно: Lampa.Storage держит in-memory кэш (readed).
            // Писать только в localStorage недостаточно — Favorite/Timeline читают кэш.
            if (window.Lampa && Lampa.Storage && typeof Lampa.Storage.set === 'function') {
                Lampa.Storage.set(key, value, true); // nolisten=true — событие шлём сами при необходимости
                return true;
            }
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[Lampa Sync] Error writing storage:', e);
            return false;
        }
    }

    /**
     * Извлечение TMDB ID из URL
     */
    function getTmdbIdFromUrl() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const card = urlParams.get('card');
            return card ? parseInt(card) : null;
        } catch (e) {
            console.error('[Lampa Sync] Error parsing URL:', e);
            return null;
        }
    }

    /**
     * file_id только из плеера / URL — без «самого свежего» file_view (это давало чужие ключи)
     */
    function getCurrentFileId() {
        try {
            if (window.Lampa && window.Lampa.Player) {
                const player = window.Lampa.Player;
                if (player.file_id) return String(player.file_id);
                if (player.file && player.file.id) return String(player.file.id);
            }
            try {
                const urlParams = new URLSearchParams(window.location.search);
                const fileId = urlParams.get('file_id');
                if (fileId) return String(fileId);
            } catch (_) {}
            return null;
        } catch (e) {
            console.error('[Lampa Sync] Error getting file_id:', e);
            return null;
        }
    }


    /**
     * HTTP запрос к серверу
     */
    async function apiRequest(endpoint, method = 'GET', body = null) {
        try {
            const config = getConfig();
            
            // Проверяем наличие пароля
            if (!config.SYNC_PASSWORD) {
                throw new Error('SYNC_PASSWORD not configured. Please set it in Lampa settings.');
            }
            
            // Однократное предупреждение: localhost с чужого http(s)-домена заблокирует CORS
            if (isLocalhostUrl(config.SYNC_SERVER_URL) && isCorsRestrictedOrigin() && !window._lampaSyncCorsWarned) {
                window._lampaSyncCorsWarned = true;
                console.warn('[Lampa Sync] Сайт открыт с другого домена, а URL сервера — localhost. Запросы будут заблокированы (CORS). Укажите публичный URL сервера (например ngrok) в настройках: window.LampaSync.showSettings()');
            }
            
            const url = `${config.SYNC_SERVER_URL}${endpoint}`;
            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.SYNC_PASSWORD}`
                }
            };
            
            // Обход страницы-предупреждения ngrok (для бесплатной версии)
            if (url.includes('ngrok') || url.includes('ngrok-free') || url.includes('ngrok.io')) {
                options.headers['ngrok-skip-browser-warning'] = 'true';
            }

            if (body) {
                options.body = JSON.stringify(body);
            }

            const response = await fetch(url, options);
            
            if (!response.ok) {
                if (response.status === 401) {
                    console.warn('[Lampa Sync] 401 Unauthorized. Пароль в настройках Lampa должен совпадать с SYNC_PASSWORD в файле .env на сервере.');
                    throw new Error('Unauthorized: Пароль в настройках должен совпадать с SYNC_PASSWORD в .env на сервере');
                }
                if (response.status === 404) {
                    // 404 - это нормально, просто прогресса нет на сервере
                    return null;
                }
                if (response.status === 413) {
                    throw new Error('Request too large (413): The favorite object is too big. Try reducing the size or contact server administrator.');
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Проверяем, что ответ действительно JSON, а не HTML (например, страница ngrok)
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                if (text.includes('<!DOCTYPE') || text.includes('<html')) {
                    throw new Error('Received HTML instead of JSON. If using ngrok, make sure to add header "ngrok-skip-browser-warning: true" or visit the URL in browser first to bypass the warning page.');
                }
                throw new Error(`Unexpected content type: ${contentType}`);
            }

            return await response.json();
        } catch (e) {
            const errorMessage = e.message || String(e);
            const isNetworkOrCors = errorMessage.includes('fetch') || errorMessage.includes('CORS') || errorMessage.includes('NetworkError');
            if (isNetworkOrCors && !window._lampaSync502Hint) {
                window._lampaSync502Hint = true;
                console.warn('[Lampa Sync] При 502 или CORS: проверьте, что сервер запущен (cd server && npm start) и ngrok проксирует (ngrok http 3000).');
            }
            
            if (errorMessage.includes('ERR_CONNECTION_REFUSED') || errorMessage.includes('Failed to fetch')) {
                const errorMsg = 'Connection refused: Server is not running or not accessible. Start server (npm start) and ngrok (ngrok http 3000).';
                console.warn('[Lampa Sync]', errorMsg);
                throw new Error(errorMsg);
            } else if (errorMessage.includes('CORS') || errorMessage.includes('blocked by CORS')) {
                const errorMsg = 'CORS/502: Server not reached. Start server and ngrok, or use same-origin URL.';
                console.warn('[Lampa Sync]', errorMsg);
                throw new Error(errorMsg);
            }
            
            console.error('[Lampa Sync] API request error:', e);
            throw e;
        }
    }

    /**
     * Проверка подключения к серверу (URL + пароль)
     */
    async function checkConnection(statusEl) {
        const setStatus = (text, ok) => {
            try {
                if (statusEl) {
                    if (statusEl.length !== undefined && statusEl.text) statusEl.text(text);
                    else if (statusEl.textContent !== undefined) statusEl.textContent = text;
                    else if (statusEl.innerText !== undefined) statusEl.innerText = text;
                }
            } catch (_) {}
            try {
                if (window.Lampa && Lampa.Noty && Lampa.Noty.show) {
                    Lampa.Noty.show(text, { time: ok ? 3000 : 5000 });
                }
            } catch (_) {}
            console.log('[Lampa Sync] Check:', text);
        };

        // Сбрасываем кэш URL/пароля из модалки, чтобы взять актуальные из Storage
        lastSavedServerUrl = null;
        lastSavedPassword = null;

        const config = getConfig();
        if (!config.SYNC_SERVER_URL) {
            setStatus('Укажите URL сервера', false);
            return false;
        }
        if (!config.SYNC_PASSWORD || !String(config.SYNC_PASSWORD).trim()) {
            setStatus('Укажите пароль синхронизации', false);
            return false;
        }

        setStatus('Проверка...', null);
        const started = Date.now();

        try {
            const data = await apiRequest('/ping');
            const ms = Date.now() - started;
            if (data && data.ok && data.auth) {
                const hist = data.history != null ? data.history : '?';
                setStatus('OK · ' + ms + ' мс · прогресс: ' + (data.records || 0) + ' · история: ' + hist, true);
                // После проверки сразу тянем favorite/progress (важно для нового устройства)
                try { await syncAll(); } catch (_) {}
                return true;
            }
            setStatus('Ответ сервера без ok/auth', false);
            return false;
        } catch (e) {
            const msg = (e && e.message) ? String(e.message) : String(e);
            if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.includes('Пароль')) {
                setStatus('Ошибка: неверный пароль', false);
            } else if (msg.includes('Connection refused') || msg.includes('Failed to fetch') || msg.includes('not running')) {
                setStatus('Ошибка: сервер недоступен', false);
            } else {
                setStatus('Ошибка: ' + msg.slice(0, 80), false);
            }
            return false;
        }
    }


    // ==================== СИНХРОНИЗАЦИЯ ====================

    /**
     * Загрузка прогресса с сервера
     */
    async function loadProgress(tmdbId) {
        const key = String(tmdbId);
        // Дедуп: один и тот же tmdb не чаще раза в 2с / пока предыдущий запрос в полёте
        if (loadInflight && lastLoadKey === key) {
            return loadInflight;
        }
        if (lastLoadKey === key && (Date.now() - lastLoadAt) < 2000) {
            return null;
        }
        lastLoadKey = key;
        lastLoadAt = Date.now();

        loadInflight = (async () => {
        try {
            // КРИТИЧНО: Проверяем, что tmdbId соответствует текущему открытому фильму
            const urlTmdbId = getTmdbIdFromUrl();
            if (urlTmdbId && parseInt(urlTmdbId) !== parseInt(tmdbId)) {
                console.log('[Lampa Sync] TMDB ID mismatch - requested:', tmdbId, 'current:', urlTmdbId, '- skipping load');
                return null;
            }
            
            console.log('[Lampa Sync] Loading progress for TMDB:', tmdbId);
            
            const data = await apiRequest(`/progress?tmdb=${tmdbId}`);
            
            if (!data) {
                console.log('[Lampa Sync] No progress found on server for TMDB:', tmdbId);
                return null;
            }
            
            // Дополнительная проверка: убеждаемся, что данные соответствуют запрошенному tmdbId
            if (data.tmdb && parseInt(data.tmdb) !== parseInt(tmdbId)) {
                console.warn('[Lampa Sync] Progress data mismatch - requested:', tmdbId, 'received:', data.tmdb);
                return null;
            }

            console.log('[Lampa Sync] Progress loaded:', data);

            const config = getConfig();

            // Обновляем file_view
            // Берём file_id из плеера; маппинг с сервера — только fallback,
            // и только если этот file_id ещё не «занят» другим tmdb в локальном кэше.
            let fileId = getCurrentFileId();
            
            if (!fileId && data.file_mapping && tmdbId) {
                for (const [fid, tmdb] of Object.entries(data.file_mapping)) {
                    if (String(tmdb) === String(tmdbId)) {
                        fileId = fid;
                        console.log('[Lampa Sync] Found file_id from mapping:', fileId, 'for tmdb:', tmdbId);
                        break;
                    }
                }
            }
            
            const urlTmdbIdCheck = getTmdbIdFromUrl();
            if (urlTmdbIdCheck && parseInt(urlTmdbIdCheck) !== parseInt(tmdbId)) {
                console.warn('[Lampa Sync] TMDB mismatch when applying - skip');
                return data;
            }
            
            if (fileId && data.time !== undefined && data.percent !== undefined) {
                // Не подменяем server mapping на «текущий» fileId — это давало чужие ключи
                
                const fileView = getStorage('file_view', {});
                
                if (fileView[fileId]) {
                    // Обновляем только если время > MIN_SEEK_TIME
                    if (data.time >= config.MIN_SEEK_TIME) {
                        const oldTime = fileView[fileId].time || 0;
                        const oldPercent = fileView[fileId].percent || 0;
                        
                        // Обновляем только если новый прогресс больше старого
                        if (data.time > oldTime || (data.time === oldTime && data.percent > oldPercent)) {
                            fileView[fileId].time = data.time;
                            fileView[fileId].percent = data.percent;
                            setStorage('file_view', fileView);
                            console.log('[Lampa Sync] ✅ Progress applied to file_view[' + fileId + ']:', {
                                oldTime: oldTime,
                                newTime: data.time,
                                oldPercent: oldPercent,
                                newPercent: data.percent
                            });
                            
                            // Обновляем lastFileViewTime для отслеживания
                            lastFileViewTime[fileId] = data.time;
                            lastFileViewTime[fileId + '_percent'] = data.percent;
                            lastFileViewTime[fileId + '_timestamp'] = Date.now();
                            
                            // Обновляем UI после изменения прогресса (только если это текущий фильм)
                            if (urlTmdbIdCheck && parseInt(urlTmdbIdCheck) === parseInt(tmdbId)) {
                                updateUIAfterProgressChange(fileId, tmdbId);
                            }
                        } else {
                            console.log('[Lampa Sync] Progress not applied - current progress is newer or equal');
                        }
                    }
                } else {
                    // Создаём новую запись только если это текущий открытый фильм
                    if (urlTmdbIdCheck && parseInt(urlTmdbIdCheck) === parseInt(tmdbId)) {
                        console.warn('[Lampa Sync] file_view[' + fileId + '] not found, creating entry');
                        fileView[fileId] = {
                            time: data.time >= config.MIN_SEEK_TIME ? data.time : 0,
                            percent: data.percent || 0,
                            duration: 0,
                            profile: 'default'
                        };
                        setStorage('file_view', fileView);
                        
                        // Обновляем lastFileViewTime
                        lastFileViewTime[fileId] = fileView[fileId].time;
                        lastFileViewTime[fileId + '_percent'] = fileView[fileId].percent;
                        lastFileViewTime[fileId + '_timestamp'] = Date.now();
                        
                        // Обновляем UI после создания новой записи
                        updateUIAfterProgressChange(fileId, tmdbId);
                    } else {
                        console.log('[Lampa Sync] Skipping file_view creation - not current movie');
                    }
                }
            } else {
                console.warn('[Lampa Sync] Cannot find file_id for tmdb:', tmdbId, '- progress not applied to file_view');
                // Сохраняем прогресс для применения позже, когда file_id появится
                if (data.time !== undefined && data.percent !== undefined) {
                    pendingProgress = {
                        tmdbId: tmdbId,
                        time: data.time,
                        percent: data.percent
                    };
                    console.log('[Lampa Sync] Progress saved for later application:', pendingProgress);
                }
            }

            // Favorite больше не тянем из per-movie записи (см. syncAll / pushFavorite)

            return data;
        } catch (e) {
            console.error('[Lampa Sync] Error loading progress:', e);
            return null;
        }
        })();

        try {
            return await loadInflight;
        } finally {
            loadInflight = null;
        }
    }

    /**
     * Обновление UI после изменения file_view
     * Вызывает события Lampa и обновляет DOM элементы
     */
    function updateUIAfterProgressChange(fileId, tmdbId) {
        try {
            // Способ 1: Вызываем событие через Subscribe (если доступно)
            if (window.Subscribe && typeof window.Subscribe.fire === 'function') {
                window.Subscribe.fire('file_view_updated', {
                    file_id: fileId,
                    tmdb_id: tmdbId
                });
                console.log('[Lampa Sync] Fired Subscribe event: file_view_updated');
            }
            
            // Способ 2: Вызываем событие через Lampa.Listener (если доступно)
            if (window.Lampa && window.Lampa.Listener && typeof window.Lampa.Listener.fire === 'function') {
                window.Lampa.Listener.fire('file_view', {
                    file_id: fileId,
                    tmdb_id: tmdbId
                });
                console.log('[Lampa Sync] Fired Lampa.Listener event: file_view');
            }
            
            // Способ 3: Обновляем DOM элементы напрямую
            // Ищем карточки с данным TMDB ID и обновляем прогресс
            if (tmdbId) {
                const fileView = getStorage('file_view', {});
                const progress = fileView[fileId];
                
                if (progress && progress.percent) {
                    // Ищем элементы карточек по различным атрибутам (Lampa может использовать разные)
                    const selectors = [
                        `[data-id="${tmdbId}"]`,
                        `[data-tmdb="${tmdbId}"]`,
                        `[data-card="${tmdbId}"]`,
                        `[href*="card=${tmdbId}"]`,
                        `[href*="?card=${tmdbId}"]`
                    ];
                    
                    let cards = [];
                    selectors.forEach(selector => {
                        try {
                            const found = document.querySelectorAll(selector);
                            if (found.length > 0) {
                                cards = Array.from(found);
                            }
                        } catch (e) {
                            // Игнорируем ошибки селекторов
                        }
                    });
                    
                    // Также ищем по URL в href (для карточек в списках)
                    if (cards.length === 0) {
                        const allLinks = document.querySelectorAll('a[href*="card="]');
                        allLinks.forEach(link => {
                            const href = link.getAttribute('href') || '';
                            if (href.includes(`card=${tmdbId}`) || href.includes(`card=${tmdbId}&`)) {
                                // Находим родительскую карточку
                                const card = link.closest('.card, [class*="card"], [class*="item"]') || link.parentElement;
                                if (card && !cards.includes(card)) {
                                    cards.push(card);
                                }
                            }
                        });
                    }
                    
                    cards.forEach(card => {
                        // Ищем элементы прогресса внутри карточки
                        const progressSelectors = [
                            '.progress',
                            '.watched-progress',
                            '.card-progress',
                            '[class*="progress"]',
                            '[class*="watched"]',
                            '[class*="percent"]'
                        ];
                        
                        progressSelectors.forEach(selector => {
                            try {
                                const progressElements = card.querySelectorAll(selector);
                                progressElements.forEach(el => {
                                    // Обновляем стиль ширины (для прогресс-баров)
                                    if (el.style) {
                                        el.style.width = progress.percent + '%';
                                        // Также обновляем через CSS переменную, если используется
                                        el.style.setProperty('--progress', progress.percent + '%');
                                    }
                                    
                                    // Обновляем текст, если это текстовый элемент
                                    if (el.textContent !== undefined && el.textContent.trim() !== '') {
                                        // Обновляем только если это похоже на процент
                                        const text = el.textContent.trim();
                                        if (text.match(/\d+%/) || text.match(/\d+\s*\/\s*\d+/)) {
                                            el.textContent = progress.percent + '%';
                                        }
                                    }
                                    
                                    // Обновляем data-атрибуты
                                    el.setAttribute('data-progress', progress.percent);
                                    el.setAttribute('data-time', progress.time);
                                });
                            } catch (e) {
                                // Игнорируем ошибки
                            }
                        });
                        
                        // Также обновляем через data-атрибуты на самой карточке
                        card.setAttribute('data-progress', progress.percent);
                        card.setAttribute('data-time', progress.time);
                        card.setAttribute('data-synced', 'true');
                        
                        // Добавляем класс для визуального индикатора обновления (опционально)
                        card.classList.add('lampasync-synced');
                        setTimeout(() => {
                            card.classList.remove('lampasync-synced');
                        }, 1000);
                    });
                    
                    if (cards.length > 0) {
                        console.log('[Lampa Sync] ✅ Updated', cards.length, 'card elements for TMDB:', tmdbId, 'Progress:', progress.percent + '%');
                    }
                    
                    // Также обновляем прогресс на открытой карточке (Full component)
                    // Проверяем, открыта ли карточка этого фильма
                    const currentUrlTmdbId = getTmdbIdFromUrl();
                    if (currentUrlTmdbId && parseInt(currentUrlTmdbId) === parseInt(tmdbId)) {
                        // Ищем элементы прогресса на странице карточки
                        const fullPageProgress = document.querySelectorAll(
                            '.full-progress, .card-progress, [class*="progress"], [class*="watched"], [class*="time"]'
                        );
                        
                        fullPageProgress.forEach(el => {
                            // Обновляем только элементы, которые явно показывают процент (не время!)
                            const text = el.textContent || '';
                            const className = el.className || '';
                            
                            // Обновляем только если элемент явно показывает процент (содержит % или класс progress/percent)
                            if (text.match(/\d+%/) || className.includes('percent') || className.includes('progress')) {
                                // Обновляем текст прогресса только если это элемент процента
                                if (progress.percent > 0 && (text.includes('%') || className.includes('percent'))) {
                                    el.textContent = progress.percent + '%';
                                }
                            }
                            
                            // Обновляем прогресс-бары (ширину)
                            if (el.style && (className.includes('progress') || className.includes('bar'))) {
                                el.style.width = progress.percent + '%';
                            }
                            
                            // НЕ обновляем элементы, которые показывают время (содержат : или мин)
                            // Это предотвращает замену времени на процент
                        });
                        
                        // Обновляем кнопку "Продолжить просмотр", если она есть
                        const continueButtons = document.querySelectorAll(
                            'button[class*="continue"], a[class*="continue"], [class*="resume"]'
                        );
                        continueButtons.forEach(btn => {
                            // Обновляем текст, если там указано время
                            const btnText = btn.textContent || '';
                            if (btnText.includes('Продолжить') || btnText.includes('Resume') || btnText.includes('Continue')) {
                                // Можно обновить текст, добавив процент
                                if (progress.percent > 0 && progress.percent < 95) {
                                    btn.setAttribute('data-progress', progress.percent);
                                }
                            }
                        });
                        
                        if (fullPageProgress.length > 0 || continueButtons.length > 0) {
                            console.log('[Lampa Sync] ✅ Updated progress on full card page for TMDB:', tmdbId);
                        }
                    }
                }
            }
            
            // Способ 4: Принудительно обновляем компоненты через Lampa API (если доступно)
            if (window.Lampa && window.Lampa.Full) {
                // Пробуем обновить компонент Full (карточка фильма)
                try {
                    const fullComponent = window.Lampa.Full;
                    if (fullComponent && typeof fullComponent.render === 'function') {
                        // Не вызываем render напрямую, это может сломать UI
                        // Вместо этого используем события
                    }
                } catch (e) {
                    // Игнорируем ошибки
                }
            }
            
            // Способ 5: Создаём кастомное событие для других плагинов/компонентов
            if (tmdbId) {
                const fileView = getStorage('file_view', {});
                const progress = fileView[fileId];
                
                const customEvent = new CustomEvent('lampasync:progress_updated', {
                    detail: {
                        file_id: fileId,
                        tmdb_id: tmdbId,
                        time: progress?.time || 0,
                        percent: progress?.percent || 0
                    }
                });
                window.dispatchEvent(customEvent);
                console.log('[Lampa Sync] Dispatched custom event: lampasync:progress_updated');
            }
            
        } catch (e) {
            console.warn('[Lampa Sync] Error updating UI:', e);
        }
    }

    /**
     * Получение текущего времени воспроизведения
     * Поддерживает как HTML5 video (браузер/десктоп), так и внешние плееры (Android)
     */
    function getCurrentPlaybackTime() {
        try {
            // Способ 1: HTML5 video элемент (браузер/десктоп)
            const video = document.querySelector('video');
            if (video && !video.paused && video.currentTime) {
                return video.currentTime;
            }
            
            // Способ 2: Через Lampa.Player API
            if (window.Lampa && window.Lampa.Player) {
                const player = window.Lampa.Player;
                
                // Пробуем получить время из встроенного video
                if (player.video && player.video.currentTime) {
                    return player.video.currentTime;
                }
                
                // Пробуем получить время напрямую из плеера
                if (player.currentTime !== undefined && player.currentTime > 0) {
                    return player.currentTime;
                }
                
                // Для внешних плееров Lampa может хранить время в других свойствах
                if (player.time !== undefined && player.time > 0) {
                    return player.time;
                }
            }
            
            // Способ 3: Для внешних плееров на Android
            // Lampa обновляет file_view при возврате из внешнего плеера
            // В этом случае возвращаем null, чтобы использовать file_view
            return null;
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Проверка, используется ли внешний плеер
     */
    function isExternalPlayer() {
        try {
            // Если нет video элемента, вероятно используется внешний плеер
            const video = document.querySelector('video');
            if (!video) {
                return true;
            }
            
            // Проверяем через Lampa.Player
            if (window.Lampa && window.Lampa.Player) {
                const player = window.Lampa.Player;
                // Если есть флаг external или externalPlayer
                if (player.external || player.externalPlayer) {
                    return true;
                }
            }
            
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Сохранение прогресса на сервер (без favorite — он через pushFavorite)
     */
    async function saveProgress(tmdbId, fileId) {
        try {
            const config = getConfig();
            const fileView = getStorage('file_view', {});

            if (!fileId || !fileView[fileId]) {
                log('No file_view for file_id:', fileId);
                return;
            }

            // Не сохраняем чужой ключ: file_id не должен быть просто tmdb другого фильма
            if (String(fileId) === String(tmdbId)) {
                // допустимо только как явный stub, но обычно это ошибка binding — пропускаем если есть Player file
                const playerFid = (window.Lampa && Lampa.Player && (Lampa.Player.file_id || (Lampa.Player.file && Lampa.Player.file.id))) || null;
                if (playerFid && String(playerFid) !== String(fileId)) {
                    fileId = String(playerFid);
                    if (!fileView[fileId]) return;
                }
            }

            const progress = fileView[fileId];
            let finalTime = progress.time || 0;
            let finalPercent = progress.percent || 0;

            const playbackTime = getCurrentPlaybackTime();
            if (playbackTime !== null && playbackTime > finalTime) {
                finalTime = playbackTime;
                if (progress.duration && progress.duration > 0) {
                    finalPercent = Math.round((finalTime / progress.duration) * 100);
                }
                fileView[fileId].time = finalTime;
                fileView[fileId].percent = finalPercent;
                setStorage('file_view', fileView);
            }

            if (finalTime < config.MIN_SEEK_TIME) {
                log('Skip save: time < MIN_SEEK_TIME', finalTime);
                return;
            }
            if (finalPercent >= config.REMOVE_AT_PERCENT) {
                log('Skip save: percent >=', config.REMOVE_AT_PERCENT);
                return;
            }

            const snapshot = `${tmdbId}|${fileId}|${Math.floor(finalTime)}|${Math.floor(finalPercent)}`;
            if (lastPostedSnapshot === snapshot) {
                log('Skip duplicate save');
                return;
            }

            const payload = {
                tmdb: tmdbId,
                time: finalTime,
                percent: finalPercent,
                file_id: fileId,
                device_id: getDeviceId()
            };

            log('Saving progress', payload);
            const result = await apiRequest('/progress', 'POST', payload);
            lastPostedSnapshot = snapshot;
            lastSavedTime = Date.now();
            console.log('[Lampa Sync] Progress saved:', Math.floor(finalTime) + 's', finalPercent + '%');
            return result;
        } catch (e) {
            console.error('[Lampa Sync] Error saving progress:', e.message || e);
        }
    }

    /**     /**
     * Отправка глобального favorite на сервер (закладки / история / удаления)
     */
    async function pushFavorite(reason) {
        try {
            const config = getConfig();
            if (!config.SYNC_PASSWORD) return null;
            const favorite = getStorage('favorite', {});
            const payload = {
                favorite: {
                    card: (favorite.card || []).map((c) => (c && typeof c === 'object' && c.id != null ? c.id : c)),
                    like: favorite.like || [],
                    watch: favorite.watch || [],
                    book: favorite.book || [],
                    history: favorite.history || [],
                    look: favorite.look || [],
                    viewed: favorite.viewed || [],
                    scheduled: favorite.scheduled || [],
                    continued: favorite.continued || [],
                    thrown: favorite.thrown || []
                }
            };
            const data = await apiRequest('/favorite', 'POST', payload);
            if (data && data.success) {
                try { localStorage.setItem('lampasync_favorite_pushed_at', data.updated || new Date().toISOString()); } catch (_) {}
                log('favorite pushed:', reason || '', data.history, data.book);
            }
            return data;
        } catch (e) {
            console.warn('[Lampa Sync] pushFavorite error:', e.message || e);
            return null;
        }
    }

    /**
     * Применить favorite с сервера (замена списков; карточки мержим с локальными объектами)
     */
    function applyFavoriteFromServer(serverFavorite) {
        if (!serverFavorite) return null;
        applyingFavorite = true;
        const current = getStorage('favorite', {});
        // списки ID — как на сервере (чтобы удаления не возвращались)
        const idArrays = ['like', 'watch', 'book', 'history', 'look', 'viewed', 'scheduled', 'continued', 'thrown'];
        const next = { ...current };
        idArrays.forEach((key) => {
            next[key] = [...new Set((serverFavorite[key] || []).map((x) => {
                if (typeof x === 'number') return x;
                if (typeof x === 'string' && /^\d+$/.test(x)) return parseInt(x, 10);
                if (x && typeof x === 'object' && x.id != null) return parseInt(x.id, 10) || x.id;
                return null;
            }).filter((x) => x != null))];
        });
        // card: сохраняем полные локальные объекты + stubs для недостающих
        const cardById = new Map();
        (current.card || []).forEach((item) => {
            if (item && typeof item === 'object' && item.id != null) cardById.set(Number(item.id) || item.id, item);
        });
        const needed = new Set([...(next.history || []), ...(next.book || []), ...(next.like || []), ...(next.watch || [])]);
        (serverFavorite.card || []).forEach((id) => needed.add(typeof id === 'object' ? id.id : id));
        next.card = [...needed].map((id) => {
            const n = Number(id) || id;
            return cardById.get(n) || { id: n, source: 'tmdb' };
        });
        setStorage('favorite', next);
        try {
            if (window.Lampa && Lampa.Favorite && typeof Lampa.Favorite.read === 'function') Lampa.Favorite.read();
        } catch (_) {}
        // небольшая задержка, чтобы Storage.listener не запушил эхо
        setTimeout(() => { applyingFavorite = false; }, 1200);
        return next;
    }

    /**
     * Догружаем title/poster для карточек-заглушек через Lampa.Api.full
     */
    function fetchCardMeta(id) {
        return new Promise((resolve) => {
            if (!window.Lampa || !Lampa.Api || typeof Lampa.Api.full !== 'function') {
                resolve(null);
                return;
            }
            const tryMethod = (method) => new Promise((res) => {
                try {
                    Lampa.Api.full(
                        { id, method, source: 'tmdb', card: { id, source: 'tmdb' } },
                        (data) => {
                            const m = data && (data.movie || data);
                            if (m && (m.title || m.name)) {
                                res({
                                    id: m.id || id,
                                    source: m.source || 'tmdb',
                                    title: m.title || null,
                                    name: m.name || null,
                                    original_title: m.original_title || null,
                                    original_name: m.original_name || null,
                                    poster_path: m.poster_path || null,
                                    backdrop_path: m.backdrop_path || null,
                                    release_date: m.release_date || null,
                                    first_air_date: m.first_air_date || null,
                                    vote_average: m.vote_average || null,
                                    media_type: method
                                });
                            } else res(null);
                        },
                        () => res(null)
                    );
                } catch (_) {
                    res(null);
                }
            });
            tryMethod('movie').then((r) => (r ? r : tryMethod('tv'))).then(resolve);
        });
    }

    async function enrichStubCards(favorite) {
        if (!favorite || !Array.isArray(favorite.card)) return favorite;
        const stubs = favorite.card.filter((c) => c && typeof c === 'object' && c.id != null && !(c.title || c.name));
        if (!stubs.length) return favorite;

        let changed = 0;
        for (const stub of stubs) {
            const meta = await fetchCardMeta(stub.id);
            if (!meta) continue;
            const idx = favorite.card.findIndex((c) => c && Number(c.id) === Number(stub.id));
            if (idx >= 0) {
                favorite.card[idx] = { ...favorite.card[idx], ...meta };
                changed++;
            }
        }
        if (changed > 0) {
            log('Enriched stub cards:', changed);
            applyingFavorite = true;
            setStorage('favorite', favorite);
            try {
                if (window.Lampa && Lampa.Favorite && typeof Lampa.Favorite.read === 'function') {
                    Lampa.Favorite.read();
                }
            } catch (_) {}
            setTimeout(() => { applyingFavorite = false; }, 1200);
        }
        return favorite;
    }

    /**
     * Полная синхронизация со сервера: favorite + max-прогресс в file_view
     */
    async function syncAll() {
        try {
            const config = getConfig();
            if (!config.SYNC_PASSWORD) {
                console.warn('[Lampa Sync] syncAll skipped: no password');
                return null;
            }

            console.log('[Lampa Sync] Full sync starting...');
            const data = await apiRequest('/sync');
            if (!data || !data.ok) {
                console.warn('[Lampa Sync] syncAll: empty/invalid response');
                return null;
            }

            // 1) Favorite
            // Правило: пустое устройство всегда тянет сервер;
            // иначе last-write-wins по updated (чтобы удаления не возвращались).
            let mergedFavorite = null;
            if (data.favorite) {
                let localPushed = null;
                try { localPushed = localStorage.getItem('lampasync_favorite_pushed_at'); } catch (_) {}
                const serverUpdated = data.favorite_updated || data.favorite.updated || null;
                const localFav = getStorage('favorite', {}) || {};
                const localHistLen = (localFav.history || []).length;
                const serverHistLen = (data.favorite.history || []).length;
                const localEmpty = localHistLen === 0 && (localFav.book || []).length === 0;
                const serverIsNewer = !!(serverUpdated && (!localPushed || new Date(serverUpdated) >= new Date(localPushed)));
                const shouldPull = localEmpty || serverIsNewer || (serverHistLen > 0 && localHistLen === 0);

                if (shouldPull) {
                    mergedFavorite = applyFavoriteFromServer(data.favorite);
                    try {
                        localStorage.setItem(
                            'lampasync_favorite_pushed_at',
                            serverUpdated || new Date().toISOString()
                        );
                    } catch (_) {}
                    console.log('[Lampa Sync] favorite pulled from server:', {
                        history: (mergedFavorite.history || []).length,
                        book: (mergedFavorite.book || []).length,
                        reason: localEmpty ? 'local-empty' : 'server-newer'
                    });
                    // Дождаться названий — иначе история на новом устройстве пустая/без постеров
                    try {
                        mergedFavorite = await enrichStubCards(mergedFavorite);
                    } catch (_) {}
                } else {
                    await pushFavorite('syncAll-local-newer');
                    mergedFavorite = getStorage('favorite', {});
                    console.log('[Lampa Sync] favorite kept local & pushed');
                }
            }

            // 2) Применяем max-прогресс в file_view
            // Один file_id не должен получать прогресс от разных tmdb
            // (в тестовых данных часто один и тот же file_id на все записи).
            const progressMap = data.progress || {};
            const fileView = getStorage('file_view', {});
            let applied = 0;

            const owners = {};
            Object.keys(progressMap).forEach((tmdb) => {
                const mapping = (progressMap[tmdb] && progressMap[tmdb].file_mapping) || {};
                Object.keys(mapping).forEach((fid) => {
                    if (String(mapping[fid]) !== String(tmdb)) return;
                    if (!owners[fid]) owners[fid] = [];
                    owners[fid].push(tmdb);
                });
            });

            Object.keys(progressMap).forEach((tmdb) => {
                const rec = progressMap[tmdb];
                if (!rec || typeof rec.time !== 'number') return;

                const mapping = rec.file_mapping || {};
                let fileIds = Object.keys(mapping).filter((fid) => String(mapping[fid]) === String(tmdb));
                // общий file_id на несколько tmdb — не трогаем чужой file_view
                fileIds = fileIds.filter((fid) => (owners[fid] || []).length <= 1);
                // Не пишем file_view[tmdb] — это загрязняет маппинг. Без реального file_id — пропускаем.
                if (!fileIds.length) return;

                fileIds.forEach((fileId) => {
                    const local = fileView[fileId] || { time: 0, percent: 0, duration: 0, profile: 'default' };
                    const serverTime = rec.time || 0;
                    const serverPercent = rec.percent || 0;
                    const localTime = local.time || 0;
                    const localPercent = local.percent || 0;

                    if (serverTime > localTime || serverPercent > localPercent) {
                        fileView[fileId] = {
                            ...local,
                            time: Math.max(localTime, serverTime),
                            percent: Math.max(localPercent, serverPercent)
                        };
                        applied++;
                    } else if (!fileView[fileId] && serverTime > 0) {
                        fileView[fileId] = {
                            time: serverTime,
                            percent: serverPercent,
                            duration: local.duration || 0,
                            profile: 'default'
                        };
                        applied++;
                    }
                });
            });

            if (applied > 0) {
                setStorage('file_view', fileView);
            }

            // Перечитываем favorite в памяти Lampa (после apply + enrich)
            try {
                if (window.Lampa && Lampa.Favorite) {
                    if (typeof Lampa.Favorite.read === 'function') Lampa.Favorite.read();
                    else if (typeof Lampa.Favorite.update === 'function') Lampa.Favorite.update();
                }
                if (window.Lampa && Lampa.Listener && typeof Lampa.Listener.send === 'function') {
                    Lampa.Listener.send('state:changed', { target: 'favorite', reason: 'sync' });
                }
            } catch (_) {}

            console.log('[Lampa Sync] ✅ Full sync done:', {
                records: data.records,
                history: data.history,
                fileViewApplied: applied
            });

            return data;
        } catch (e) {
            console.warn('[Lampa Sync] syncAll error:', e.message || e);
            return null;
        }
    }

    // ==================== ОБРАБОТЧИКИ СОБЫТИЙ ====================

    let syncTimeout = null;
    let currentTmdbId = null;
    let currentFileId = null;
    let lastSavedTime = 0;
    let pendingProgress = null; // Сохраняем прогресс, если file_id ещё не найден
    let lastPostedSnapshot = null; // tmdb|fileId|time|percent — не шлём одинаковый POST
    let loadInflight = null; // дедуп параллельных loadProgress
    let lastLoadKey = null;
    let lastLoadAt = 0;
    let lastFileViewTime = {}; // Отслеживание времени file_view для предотвращения дублирования
    let playbackSessionActive = false; // true только после реального роста time в сессии

    /**
     * Обработчик события start
     */
    async function handleStart() {
        if (syncTimeout) {
            clearTimeout(syncTimeout);
            syncTimeout = null;
        }

        const tmdbId = getTmdbIdFromUrl();
        if (!tmdbId) {
            currentTmdbId = null;
            currentFileId = null;
            return;
        }

        if (currentTmdbId && parseInt(currentTmdbId) !== parseInt(tmdbId)) {
            currentFileId = null;
            pendingProgress = null;
            playbackSessionActive = false;
            lastPostedSnapshot = null;
        }

        currentTmdbId = tmdbId;
        const fileId = getCurrentFileId();
        if (fileId) currentFileId = fileId;

        log('handleStart tmdb=', tmdbId, 'fileId=', currentFileId);
        await loadProgress(tmdbId);
    }

    /**
     * Обработчик событий pause/stop/ended
     */
    function handleSave() {
        console.log('[Lampa Sync] Player paused/stopped/ended');
        
        const config = getConfig();
        
        // Откладываем сохранение на SYNC_DELAY
        if (syncTimeout) {
            clearTimeout(syncTimeout);
        }

        syncTimeout = setTimeout(async () => {
            if (currentTmdbId && currentFileId && playbackSessionActive) {
                await saveProgress(currentTmdbId, currentFileId);
                lastSavedTime = Date.now();
            }
            playbackSessionActive = false;
        }, config.SYNC_DELAY);
    }

    // ==================== ИНИЦИАЛИЗАЦИЯ ====================

    /**
     * Кнопка «Обновить» в шапке рядом с поиском / уведомлениями
     */
    function addHeadSyncButton() {
        if (window._lampaSyncHeadBtn) return true;
        if (!window.Lampa || !Lampa.Head || typeof Lampa.Head.addIcon !== 'function') return false;

        // Иконка обновления (круговые стрелки)
        const svg = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7c2.76 0 5 2.24 5 5a5 5 0 0 1-8.9 3.1L6.7 16.5A7 7 0 0 0 19 12c0-1.93-.78-3.68-2.05-4.95zM6 12c0-2.76 2.24-5 5-5v4l5-5-5-5v3c-3.87 0-7 3.13-7 7 0 1.93.78 3.68 2.05 4.95l1.45-1.45A4.98 4.98 0 0 1 6 12z"/>' +
            '</svg>';

        let syncing = false;
        const btn = Lampa.Head.addIcon(svg, function () {
            if (syncing) return;
            const config = getConfig();
            if (!config.SYNC_PASSWORD) {
                try {
                    if (Lampa.Noty) Lampa.Noty.show('Укажите пароль синхронизации в настройках', { time: 3000 });
                } catch (_) {}
                return;
            }

            syncing = true;
            try { if (btn && btn.addClass) btn.addClass('active'); } catch (_) {}
            try {
                if (Lampa.Noty) Lampa.Noty.show('Синхронизация…', { time: 1500 });
            } catch (_) {}

            syncAll()
                .then((data) => {
                    const hist = data && data.history != null ? data.history : '?';
                    const rec = data && data.records != null ? data.records : '?';
                    const msg = data && data.ok
                        ? ('Готово · история: ' + hist + ' · прогресс: ' + rec)
                        : 'Синхронизация не удалась';
                    try { if (Lampa.Noty) Lampa.Noty.show(msg, { time: 3000 }); } catch (_) {}
                })
                .catch((e) => {
                    const msg = (e && e.message) ? String(e.message).slice(0, 80) : 'Ошибка синхронизации';
                    try { if (Lampa.Noty) Lampa.Noty.show(msg, { time: 4000 }); } catch (_) {}
                })
                .finally(() => {
                    syncing = false;
                    try { if (btn && btn.removeClass) btn.removeClass('active'); } catch (_) {}
                });
        });

        try {
            if (btn && btn.addClass) btn.addClass('open--lampasync');
            // Ставим рядом с поиском (после него), иначе оставляем в head__actions
            const head = typeof Lampa.Head.render === 'function' ? Lampa.Head.render() : null;
            if (head && btn) {
                const search = head.find ? head.find('.open--search') : null;
                if (search && search.length) {
                    btn.insertAfter(search);
                }
            }
            // Подсказка для мыши / long-press где поддерживается
            if (btn && btn.attr) btn.attr('title', 'Синхронизация прогресса');
        } catch (_) {}

        window._lampaSyncHeadBtn = true;
        console.log('[Lampa Sync] Head sync button added');
        return true;
    }

    /**
     * Карточка в списке расширений: author/name/descr
     * (без author Lampa показывает дефолт @lampa)
     */
    function updatePluginCard() {
        try {
            if (!window.Lampa || !Lampa.Plugins || typeof Lampa.Plugins.get !== 'function') return false;

            const META = {
                name: 'Lampa Sync',
                author: '@kotopheiop',
                descr: 'Синхронизация прогресса, истории и закладок между устройствами',
                version: '1.2.0'
            };

            const ourBase = (PLUGIN_SCRIPT_URL || '').split('?')[0];
            const list = Lampa.Plugins.get() || [];
            let changed = false;

            list.forEach((plug) => {
                if (!plug || !plug.url) return;
                const plugBase = String(plug.url).split('?')[0];
                const isOurs = (ourBase && (plugBase === ourBase || ourBase.indexOf(plugBase) === 0 || plugBase.indexOf(ourBase) === 0))
                    || /lampa-sync/i.test(plugBase)
                    || (plug.name && /^lampa\s*sync$/i.test(String(plug.name).trim()));

                if (!isOurs) return;

                if (plug.author !== META.author) { plug.author = META.author; changed = true; }
                if (plug.name !== META.name) { plug.name = META.name; changed = true; }
                if (plug.descr !== META.descr) { plug.descr = META.descr; changed = true; }
                if (plug.version !== META.version) { plug.version = META.version; changed = true; }
            });

            if (changed && typeof Lampa.Plugins.save === 'function') {
                Lampa.Plugins.save();
                console.log('[Lampa Sync] Plugin card updated:', META);
            }
            return true;
        } catch (e) {
            console.warn('[Lampa Sync] updatePluginCard failed:', e.message || e);
            return false;
        }
    }

    /**
     * Инициализация плагина
     */
    function startPlugin() {
        if (window._lampaSyncStarted) return;
        window._lampaSyncStarted = true;
        console.log('[Lampa Sync] Plugin initialized by @kotopheiop');

        updatePluginCard();
        
        // Если в localStorage уже сохранён не-localhost URL и пароль — фиксируем их, чтобы запросы не уходили на localhost
        try {
            const u = localStorage.getItem('lampa_sync_server_url');
            const p = localStorage.getItem('lampa_sync_password');
            if (u && typeof u === 'string' && p !== null && String(p).trim().length > 0 && !isLocalhostUrl(u)) {
                lastSavedServerUrl = u.trim();
                lastSavedPassword = String(p).trim();
            }
        } catch (e) {}
        
        const config = getConfig();
        console.log('[Lampa Sync] Server URL:', config.SYNC_SERVER_URL);
        
        // Проверяем наличие пароля
        if (!config.SYNC_PASSWORD) {
            console.warn('[Lampa Sync] SYNC_PASSWORD not configured. Please set it in Lampa settings (Настройки → Интерфейс → Синхронизация прогресса).');
        } else {
            // Проверяем доступность сервера и сразу тянем полный sync
            apiRequest('/health')
                .then(data => {
                    console.log('[Lampa Sync] ✅ Server is available:', data);
                    return syncAll();
                })
                .catch(e => {
                    // Более информативное сообщение об ошибке
                    const errorMsg = e.message || String(e);
                    
                    if (errorMsg.includes('Connection refused') || errorMsg.includes('ERR_CONNECTION_REFUSED')) {
                        console.warn('[Lampa Sync] ⚠️ Connection refused - server is not running or not accessible.');
                        console.warn('[Lampa Sync] 💡 Solutions:');
                        console.warn('[Lampa Sync]   1. Make sure the server is running: cd server && npm start');
                        console.warn('[Lampa Sync]   2. Check that the server listens on 0.0.0.0 (not just localhost)');
                        console.warn('[Lampa Sync]   3. Check Windows Firewall - port 3000 should be allowed');
                        console.warn('[Lampa Sync]   4. Verify the server URL in settings matches your IP: http://192.168.1.193:3000');
                    } else if (errorMsg.includes('CORS')) {
                        console.warn('[Lampa Sync] ⚠️ CORS error - server may not be accessible from this origin.');
                        console.warn('[Lampa Sync] 💡 Solutions:');
                        console.warn('[Lampa Sync]   1. Use your local IP instead of localhost (e.g., http://192.168.1.193:3000)');
                        console.warn('[Lampa Sync]   2. Make sure CORS is enabled on the server');
                        console.warn('[Lampa Sync]   3. For production, use HTTPS with proper CORS configuration');
                    } else {
                        console.warn('[Lampa Sync] ⚠️ Server is not available:', errorMsg);
                        console.warn('[Lampa Sync] Make sure the server is running and the URL is correct.');
                    }
                });
        }

        // Пушим favorite при изменениях (закладки / удаление из истории)
        let favoritePushTimer = null;
        try {
            if (window.Lampa && Lampa.Storage && Lampa.Storage.listener && typeof Lampa.Storage.listener.follow === 'function') {
                Lampa.Storage.listener.follow('change', (e) => {
                    if (!e || e.name !== 'favorite') return;
                    if (applyingFavorite) return;
                    if (favoritePushTimer) clearTimeout(favoritePushTimer);
                    favoritePushTimer = setTimeout(() => {
                        if (applyingFavorite) return;
                        pushFavorite('storage-change').catch(() => {});
                    }, 800);
                });
                console.log('[Lampa Sync] Storage listener registered for favorite');
            }
        } catch (e) {
            console.warn('[Lampa Sync] favorite listener failed:', e.message || e);
        }

        // ---- Единый трекер file_view + навигации ----
        let lastFileView = getStorage('file_view', {});
        if (Object.keys(lastFileViewTime).length === 0) {
            Object.keys(lastFileView).forEach((fileId) => {
                const p = lastFileView[fileId] || {};
                lastFileViewTime[fileId] = p.time || 0;
                lastFileViewTime[fileId + '_percent'] = p.percent || 0;
                lastFileViewTime[fileId + '_timestamp'] = Date.now();
            });
        }
        let lastTmdbId = getTmdbIdFromUrl();

        function onMovieChanged(tmdbId, reason) {
            if (!tmdbId || tmdbId === lastTmdbId) return;
            log('Movie changed via', reason, tmdbId);
            lastTmdbId = tmdbId;
            currentTmdbId = tmdbId;
            handleStart();
        }

        function trackChanges() {
            const currentFileView = getStorage('file_view', {});
            const currentKeys = Object.keys(currentFileView);
            const lastKeys = Object.keys(lastFileView);

            // URL / TMDB
            onMovieChanged(getTmdbIdFromUrl(), 'poll');

            // Новый file_view ключ во время текущего фильма
            if (currentKeys.length > lastKeys.length && currentTmdbId) {
                const added = currentKeys.filter((k) => !lastKeys.includes(k));
                const real = added.find((k) => String(k) !== String(currentTmdbId));
                if (real) {
                    currentFileId = real;
                    log('Bound file_id', currentFileId, '->', currentTmdbId);
                    // не ставим playbackSessionActive здесь — только после роста time
                }
            }

            currentKeys.forEach((fileId) => {
                if (!currentTmdbId || fileId !== currentFileId) return;
                const currentProgress = currentFileView[fileId] || {};
                let currentTime = currentProgress.time || 0;
                let currentPercent = currentProgress.percent || 0;
                const lastTime = lastFileViewTime[fileId] || 0;

                const playbackTime = getCurrentPlaybackTime();
                if (playbackTime !== null && playbackTime > currentTime) {
                    currentTime = playbackTime;
                    if (currentProgress.duration > 0) {
                        currentPercent = Math.round((currentTime / currentProgress.duration) * 100);
                    }
                    const fv = getStorage('file_view', {});
                    if (fv[fileId]) {
                        fv[fileId].time = currentTime;
                        fv[fileId].percent = currentPercent;
                        setStorage('file_view', fv);
                    }
                }

                if (currentTime > lastTime && lastTime > 0) {
                    playbackSessionActive = true;
                }

                const config = getConfig();
                if (playbackSessionActive && currentTime > lastTime && currentTime >= config.MIN_SEEK_TIME) {
                    if (syncTimeout) clearTimeout(syncTimeout);
                    syncTimeout = setTimeout(() => {
                        if (currentTmdbId && currentFileId && playbackSessionActive) {
                            saveProgress(currentTmdbId, currentFileId).catch(() => {});
                        }
                    }, 5000);
                }

                // Пауза: время не растёт >3с
                if (playbackSessionActive && currentTime > 0 && currentTime === lastTime && lastTime > 0) {
                    const since = Date.now() - (lastFileViewTime[fileId + '_timestamp'] || 0);
                    const pauseKey = fileId + '_pause_saved';
                    if (since > 3000 && !lastFileViewTime[pauseKey]) {
                        lastFileViewTime[pauseKey] = 1;
                        handleSave();
                    }
                } else if (currentTime !== lastTime) {
                    delete lastFileViewTime[fileId + '_pause_saved'];
                }

                if (currentTime !== lastTime || currentPercent !== (lastFileViewTime[fileId + '_percent'] || 0)) {
                    lastFileViewTime[fileId] = currentTime;
                    lastFileViewTime[fileId + '_percent'] = currentPercent;
                    lastFileViewTime[fileId + '_timestamp'] = Date.now();
                }
            });

            lastFileView = JSON.parse(JSON.stringify(currentFileView));
        }

        setInterval(trackChanges, 1000);

        // Карточка открыта
        if (window.Lampa && Lampa.Listener && typeof Lampa.Listener.follow === 'function') {
            try {
                Lampa.Listener.follow('full', function (e) {
                    if (e && e.type === 'complite') {
                        setTimeout(() => onMovieChanged(getTmdbIdFromUrl(), 'listener'), 300);
                    }
                });
            } catch (_) {}
        }

        // History API (один раз)
        if (!window._lampaSyncHistoryPatched) {
            window._lampaSyncHistoryPatched = true;
            const _push = history.pushState;
            const _replace = history.replaceState;
            history.pushState = function () {
                _push.apply(history, arguments);
                setTimeout(() => onMovieChanged(getTmdbIdFromUrl(), 'pushState'), 200);
            };
            history.replaceState = function () {
                _replace.apply(history, arguments);
                setTimeout(() => onMovieChanged(getTmdbIdFromUrl(), 'replaceState'), 200);
            };
            window.addEventListener('popstate', () => {
                setTimeout(() => onMovieChanged(getTmdbIdFromUrl(), 'popstate'), 200);
            });
        }

        window.addEventListener('beforeunload', () => { handleSave(); });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            // При возврате из внешнего плеера Lampa обновляет file_view — сохраняем
            if (currentTmdbId && currentFileId && playbackSessionActive) {
                handleSave();
            } else if (currentTmdbId) {
                const fv = getStorage('file_view', {});
                // если file_id ещё не знали — подхватим новый ключ с выросшим time
                const tmdb = String(currentTmdbId);
                let best = currentFileId;
                let bestTime = best && fv[best] ? (fv[best].time || 0) : 0;
                Object.keys(fv).forEach((k) => {
                    if (String(k) === tmdb) return;
                    const t = fv[k] && fv[k].time || 0;
                    const prev = lastFileViewTime[k] || 0;
                    if (t > prev && t > bestTime && t >= getConfig().MIN_SEEK_TIME) {
                        best = k;
                        bestTime = t;
                    }
                });
                if (best && bestTime > 0) {
                    currentFileId = best;
                    playbackSessionActive = true;
                    handleSave();
                }
            }
        });

        // Периодический save во время просмотра (реже)
        setInterval(() => {
            if (!playbackSessionActive || !currentTmdbId || !currentFileId) return;
            if (Date.now() - lastSavedTime < 30000) return;
            const fv = getStorage('file_view', {});
            const p = fv[currentFileId];
            if (!p || !(p.time >= getConfig().MIN_SEEK_TIME)) return;
            saveProgress(currentTmdbId, currentFileId).catch(() => {});
        }, 30000);

        // Кнопка sync в шапке (рядом с поиском)
        if (!addHeadSyncButton()) {
            let tries = 0;
            const t = setInterval(() => {
                tries++;
                if (addHeadSyncButton() || tries > 20) clearInterval(t);
            }, 500);
        }
    }

    // ==================== НАСТРОЙКИ LAMPA ====================
    
    /**
     * Добавление пункта меню в настройки
     */
    function addSettingsMenu() {
        try {
            if (Lampa.Settings && Lampa.Settings.main && Lampa.Settings.main() && 
                !Lampa.Settings.main().render().find('[data-component="lampa_sync"]').length) {
                
                const field = $(`
                    <div class="settings-folder selector" data-component="lampa_sync">
                        <div class="settings-folder__icon">
                            <svg height="260" viewBox="0 0 244 260" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M122 0L0 60v200h244V60L122 0zm0 40l90 50v150H32V90l90-50z" fill="white"/>
                                <path d="M122 100l-40 20v80h80v-80l-40-20z" fill="white"/>
                            </svg>
                        </div>
                        <div class="settings-folder__name">Синхронизация прогресса</div>
                    </div>
                `);
                
                // Добавляем после пункта "more" или в конец
                const moreElement = Lampa.Settings.main().render().find('[data-component="more"]');
                if (moreElement.length) {
                    moreElement.after(field);
                } else {
                    Lampa.Settings.main().render().append(field);
                }
                
                Lampa.Settings.main().update();
                console.log('[Lampa Sync] ✅ Settings menu added');
                return true;
            }
            return false;
        } catch (e) {
            console.error('[Lampa Sync] Error adding settings menu:', e);
            return false;
        }
    }
    
    /**
     * Регистрация input-параметров в Lampa.Params
     * Без этого update() падает: values[name][ 'http://...' ] на undefined
     */
    function registerSettingsParams() {
        try {
            if (!window.Lampa || !Lampa.Params || typeof Lampa.Params.select !== 'function') {
                return false;
            }
            // Для input второй аргумент — строка (не объект select-опций)
            Lampa.Params.select('lampa_sync_server_url', '', 'http://127.0.0.1:3000');
            Lampa.Params.select('lampa_sync_password', '', '');
            console.log('[Lampa Sync] ✅ Params registered');
            return true;
        } catch (e) {
            console.warn('[Lampa Sync] Params.register failed:', e);
            return false;
        }
    }

    /**
     * Инициализация настроек - добавление шаблона и полей
     */
    function initSettingsTemplate() {
        try {
            if (!window.Lampa || !window.Lampa.Template) {
                console.log('[Lampa Sync] Lampa.Template not available yet');
                return false;
            }

            registerSettingsParams();
            
            // Очищаем только некорректные ключи (URL как ключ). Не трогаем сохранённые настройки пользователя.
            try {
                const allKeys = Object.keys(localStorage);
                let cleanedCount = 0;
                allKeys.forEach(key => {
                    if (key.startsWith('http://') || key.startsWith('https://')) {
                        console.warn('[Lampa Sync] Removing invalid key before template add:', key);
                        localStorage.removeItem(key);
                        cleanedCount++;
                    }
                });
                
                if (cleanedCount > 0) {
                    console.log('[Lampa Sync] Cleaned', cleanedCount, 'invalid keys before template add');
                }
                
                // Устанавливаем значения по умолчанию ТОЛЬКО если ключей ещё нет (первый запуск)
                const hasUrl = localStorage.getItem('lampa_sync_server_url');
                const hasPassword = localStorage.getItem('lampa_sync_password');
                if (!hasUrl || hasPassword === null) {
                    const defaultUrl = 'http://127.0.0.1:3000';
                    if (!hasUrl) {
                        localStorage.setItem('lampa_sync_server_url', defaultUrl);
                        if (Lampa.Storage && Lampa.Storage.set) {
                            Lampa.Storage.set('lampa_sync_server_url', defaultUrl);
                        }
                    }
                    if (hasPassword === null) {
                        localStorage.setItem('lampa_sync_password', '');
                        if (Lampa.Storage && Lampa.Storage.set) {
                            Lampa.Storage.set('lampa_sync_password', '');
                        }
                    }
                }
            } catch (e) {
                console.error('[Lampa Sync] Error cleaning before template add:', e);
            }
            
            const template = `
                <div>
                    <div class="settings-param selector" data-name="lampa_sync_server_url" data-type="input" data-string="true" placeholder="http://127.0.0.1:3000">
                        <div class="settings-param__name">URL сервера синхронизации</div>
                        <div class="settings-param__value"></div>
                    </div>
                    <div class="settings-param selector" data-name="lampa_sync_password" data-type="input" data-string="true" placeholder="Введите пароль">
                        <div class="settings-param__name">Пароль синхронизации</div>
                        <div class="settings-param__value"></div>
                    </div>
                    <div class="settings-param selector" data-name="lampa_sync_check" data-static="true">
                        <div class="settings-param__name">Проверить подключение</div>
                        <div class="settings-param__value" id="lampasync-check-status">Нажмите для проверки</div>
                    </div>
                    <div class="settings-param" data-static="true" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #444;">
                        <div class="settings-param__name" style="color: #888; font-size: 12px;">ID устройства (для отладки)</div>
                        <div class="settings-param__value" style="color: #aaa; font-size: 11px; word-break: break-all;" id="lampasync-device-id-display"></div>
                    </div>
                </div>
            `;
            
            // Добавляем шаблон
            Lampa.Template.add('settings_lampa_sync', template);
            console.log('[Lampa Sync] ✅ Settings template added');
            
            // КРИТИЧНО: Перехватываем ошибки при открытии настроек
            // Lampa может пытаться использовать URL как ключ, что вызывает ошибку
            const originalErrorHandler = window.onerror;
            window.addEventListener('error', function(e) {
                if (e.message && e.message.includes('Cannot read properties of undefined') && 
                    (e.message.includes('http://') || e.message.includes('https://'))) {
                    console.warn('[Lampa Sync] Detected error with URL as key, cleaning storage...');
                    // Очищаем некорректные значения
                    try {
                        const allKeys = Object.keys(localStorage);
                        allKeys.forEach(key => {
                            if (key.startsWith('http://') || key.startsWith('https://')) {
                                localStorage.removeItem(key);
                            }
                        });
                        // не сбрасываем URL/пароль пользователя — только битые URL-ключи

                    } catch (err) {
                        console.error('[Lampa Sync] Error in error handler:', err);
                    }
                }
            }, true);
            
            // Инициализируем значения по умолчанию и очищаем некорректные значения
            if (window.Lampa && window.Lampa.Storage) {
                try {
                    // Агрессивная очистка: удаляем все ключи, которые являются URL
                    // Это исправляет проблему, когда значение сохранилось как ключ
                    // Очистка уже выполнена в начале плагина, но делаем ещё раз для надёжности
                    try {
                        // Пробуем получить все ключи через localStorage напрямую
                        const storageKeys = Object.keys(localStorage);
                        storageKeys.forEach(key => {
                            // Если ключ - это URL (начинается с http), удаляем его
                            if (key.startsWith('http://') || key.startsWith('https://')) {
                                console.warn('[Lampa Sync] Removing invalid storage key (URL):', key);
                                try {
                                    localStorage.removeItem(key);
                                    if (Lampa.Storage && Lampa.Storage.remove) {
                                        Lampa.Storage.remove(key);
                                    }
                                } catch (e) {
                                    // Игнорируем ошибки
                                }
                            }
                        });
                    } catch (e) {
                        // Игнорируем ошибки при очистке
                    }
                    
                    // Инициализируем правильные значения
                    let currentUrl = null;
                    let currentPassword = null;
                    
                    try {
                        currentUrl = Lampa.Storage.get('lampa_sync_server_url');
                        currentPassword = Lampa.Storage.get('lampa_sync_password');
                    } catch (e) {
                        console.warn('[Lampa Sync] Error reading storage:', e);
                    }
                    
                    // Если значение - не строка или содержит URL как ключ, сбрасываем
                    if (currentUrl && typeof currentUrl !== 'string') {
                        console.warn('[Lampa Sync] Invalid URL value type, resetting');
                        currentUrl = null;
                    }
                    
                    if (currentPassword && typeof currentPassword !== 'string') {
                        console.warn('[Lampa Sync] Invalid password value type, resetting');
                        currentPassword = null;
                    }
                    
                    // Устанавливаем значения по умолчанию, если их нет
                    if (!currentUrl) {
                        Lampa.Storage.set('lampa_sync_server_url', 'http://localhost:3000');
                    }
                    
                    if (currentPassword === null || currentPassword === undefined) {
                        Lampa.Storage.set('lampa_sync_password', '');
                    }
                    
                    // Дополнительная проверка: убеждаемся, что значения - это строки
                    const finalUrl = Lampa.Storage.get('lampa_sync_server_url');
                    const finalPassword = Lampa.Storage.get('lampa_sync_password');
                    
                    if (typeof finalUrl !== 'string') {
                        console.error('[Lampa Sync] URL is still not a string, forcing reset');
                        Lampa.Storage.set('lampa_sync_server_url', 'http://localhost:3000');
                    }
                    
                    if (typeof finalPassword !== 'string') {
                        console.error('[Lampa Sync] Password is still not a string, forcing reset');
                        Lampa.Storage.set('lampa_sync_password', '');
                    }
                    
                } catch (e) {
                    console.error('[Lampa Sync] Error initializing storage values:', e);
                    // Устанавливаем значения по умолчанию в любом случае
                    try {
                        Lampa.Storage.set('lampa_sync_server_url', 'http://localhost:3000');
                        Lampa.Storage.set('lampa_sync_password', '');
                    } catch (e2) {
                        console.error('[Lampa Sync] Error setting default values:', e2);
                    }
                }
            }
            
            // КРИТИЧНО: Перехватываем чтение значений через Lampa.Storage
            // Если Lampa пытается прочитать значение и использует его как ключ, перехватываем это
            try {
                if (Lampa.Storage && Lampa.Storage.get) {
                    const originalGet = Lampa.Storage.get;
                    Lampa.Storage.get = function(key) {
                        // Если ключ - это URL, возвращаем undefined
                        if (key && (key.startsWith('http://') || key.startsWith('https://'))) {
                            console.warn('[Lampa Sync] Prevented reading URL as key:', key);
                            return undefined;
                        }
                        
                        // Если читаем наши параметры, убеждаемся, что значение правильное
                        if (key === 'lampa_sync_server_url' || key === 'lampa_sync_password') {
                            const value = originalGet.apply(this, arguments);
                            // Если значение - не строка, возвращаем значение по умолчанию
                            if (key === 'lampa_sync_server_url' && (typeof value !== 'string' || !value)) {
                                return 'http://localhost:3000';
                            }
                            if (key === 'lampa_sync_password' && typeof value !== 'string') {
                                return '';
                            }
                            return value;
                        }
                        
                        return originalGet.apply(this, arguments);
                    };
                    console.log('[Lampa Sync] Storage.get intercepted');
                }
            } catch (e) {
                console.warn('[Lampa Sync] Could not intercept Storage.get:', e);
            }
            
            // Также перехватываем через MutationObserver для очистки перед рендерингом
            try {
                const settingsObserver = new MutationObserver(function(mutations) {
                    const settingsContainer = document.querySelector('.settings');
                    if (settingsContainer && settingsContainer.style.display !== 'none') {
                        try {
                            // Только удаляем ключи-URL. Наши настройки не перезаписываем.
                            const allKeys = Object.keys(localStorage);
                            allKeys.forEach(key => {
                                if (key.startsWith('http://') || key.startsWith('https://')) {
                                    localStorage.removeItem(key);
                                }
                            });
                        } catch (e) {
                            // Игнорируем ошибки
                        }
                    }
                });
                
                settingsObserver.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['style', 'class']
                });
                
                console.log('[Lampa Sync] Settings observer initialized');
            } catch (e) {
                console.warn('[Lampa Sync] Could not initialize settings observer:', e);
            }
            
            // Слушаем открытие настроек
            if (Lampa.Settings && Lampa.Settings.listener) {
                Lampa.Settings.listener.follow('open', function(e) {
                    // Очищаем только некорректные ключи (URL как ключ). Сохранённые настройки не трогаем.
                    try {
                        const allKeys = Object.keys(localStorage);
                        let cleanedCount = 0;
                        allKeys.forEach(key => {
                            if (key.startsWith('http://') || key.startsWith('https://')) {
                                console.warn('[Lampa Sync] Removing invalid key before settings open:', key);
                                localStorage.removeItem(key);
                                cleanedCount++;
                                if (Lampa.Storage && Lampa.Storage.remove) {
                                    try {
                                        Lampa.Storage.remove(key);
                                    } catch (e) {
                                        // Игнорируем
                                    }
                                }
                            }
                        });
                        
                        if (cleanedCount > 0) {
                            console.log('[Lampa Sync] Cleaned', cleanedCount, 'invalid keys before settings open');
                        }
                        
                        // Убеждаемся, что наши параметры — строки (для Lampa). Не перезаписываем значения пользователя.
                        const urlVal = localStorage.getItem('lampa_sync_server_url');
                        const pwdVal = localStorage.getItem('lampa_sync_password');
                        if (urlVal === null || typeof urlVal !== 'string') {
                            localStorage.setItem('lampa_sync_server_url', 'http://localhost:3000');
                            if (Lampa.Storage && Lampa.Storage.set) {
                                Lampa.Storage.set('lampa_sync_server_url', 'http://localhost:3000');
                            }
                        }
                        if (pwdVal === null || typeof pwdVal !== 'string') {
                            localStorage.setItem('lampa_sync_password', '');
                            if (Lampa.Storage && Lampa.Storage.set) {
                                Lampa.Storage.set('lampa_sync_password', '');
                            }
                        }
                    } catch (e) {
                        console.error('[Lampa Sync] Error cleaning before settings open:', e);
                    }
                    
                    if (e.name == 'lampa_sync') {
                        // Настройки открыты — Params уже зарегистрированы, дополнительно подставляем значения
                        console.log('[Lampa Sync] Settings opened');
                        registerSettingsParams();

                        setTimeout(() => {
                            try {
                                const cfg = getConfig();
                                if (e.body && e.body.find) {
                                    e.body.find('[data-name="lampa_sync_server_url"] .settings-param__value')
                                        .text(cfg.SYNC_SERVER_URL || 'http://127.0.0.1:3000');
                                    e.body.find('[data-name="lampa_sync_password"] .settings-param__value')
                                        .text(cfg.SYNC_PASSWORD ? cfg.SYNC_PASSWORD : '');
                                    const deviceIdDisplay = e.body.find('#lampasync-device-id-display');
                                    if (deviceIdDisplay && deviceIdDisplay.length) {
                                        deviceIdDisplay.text(getDeviceId());
                                    }

                                    const checkBtn = e.body.find('[data-name="lampa_sync_check"]');
                                    const statusEl = e.body.find('#lampasync-check-status');
                                    if (statusEl && statusEl.length) {
                                        statusEl.text('Нажмите для проверки');
                                    }
                                    if (checkBtn && checkBtn.length) {
                                        checkBtn.unbind('hover:enter').on('hover:enter', function () {
                                            checkConnection(statusEl);
                                        });
                                    }
                                }
                            } catch (err) {
                                console.warn('[Lampa Sync] Could not fill settings values:', err);
                            }
                        }, 50);
                    }
                });
            }
            
            return true;
        } catch (e) {
            console.error('[Lampa Sync] Error initializing settings template:', e);
            return false;
        }
    }
    
    /**
     * Создание модального окна для настроек (fallback)
     */
    function showSettingsModal() {
        try {
            const config = getConfig();
            
            // Если плагин загружен из iframe (CDN), модалка должна быть в top-документе, иначе её не видно
            let targetDoc = document;
            try {
                if (window.top && window.top !== window && window.top.document && window.top.document.body) {
                    targetDoc = window.top.document;
                }
            } catch (e) {
                // Cross-origin: остаёмся в текущем document
            }
            
            // Создаём HTML для модального окна
            const modalHtml = `
                <div class="lampasync-settings-modal" style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.8);
                    z-index: 99999;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">
                    <div style="
                        background: #1a1a1a;
                        padding: 30px;
                        border-radius: 10px;
                        max-width: 500px;
                        width: 90%;
                        color: #fff;
                        font-family: Arial, sans-serif;
                    ">
                        <h2 style="margin-top: 0; color: #fff;">⚙️ Настройки синхронизации Lampa</h2>
                        
                        <div style="margin-bottom: 20px;">
                            <label style="display: block; margin-bottom: 5px; color: #ccc;">
                                URL сервера синхронизации:
                            </label>
                            <input type="text" id="lampasync-server-url" 
                                value="${config.SYNC_SERVER_URL}" 
                                style="
                                    width: 100%;
                                    padding: 10px;
                                    background: #2a2a2a;
                                    border: 1px solid #444;
                                    border-radius: 5px;
                                    color: #fff;
                                    font-size: 14px;
                                    box-sizing: border-box;
                                "
                                placeholder="http://localhost:3000"
                                autocomplete="off"
                                spellcheck="false"
                                readonly="false"
                                disabled="false"
                                contenteditable="true"
                            />
                            <small style="color: #888; font-size: 12px;">
                                Адрес сервера для синхронизации прогресса
                            </small>
                        </div>
                        
                        <div style="margin-bottom: 20px;">
                            <label style="display: block; margin-bottom: 5px; color: #ccc;">
                                Пароль синхронизации:
                            </label>
                            <input type="password" id="lampasync-password" 
                                value="${config.SYNC_PASSWORD}" 
                                style="
                                    width: 100%;
                                    padding: 10px;
                                    background: #2a2a2a;
                                    border: 1px solid #444;
                                    border-radius: 5px;
                                    color: #fff;
                                    font-size: 14px;
                                    box-sizing: border-box;
                                "
                                placeholder="Введите пароль"
                                autocomplete="off"
                                spellcheck="false"
                                readonly="false"
                                disabled="false"
                                contenteditable="true"
                            />
                            <small style="color: #888; font-size: 12px;">
                                Должен совпадать с SYNC_PASSWORD в .env сервера
                            </small>
                        </div>
                        
                        <div style="display: flex; gap: 10px; justify-content: flex-end;">
                            <button id="lampasync-save" style="
                                padding: 10px 20px;
                                background: #4CAF50;
                                border: none;
                                border-radius: 5px;
                                color: #fff;
                                cursor: pointer;
                                font-size: 14px;
                            ">💾 Сохранить</button>
                            <button id="lampasync-cancel" style="
                                padding: 10px 20px;
                                background: #666;
                                border: none;
                                border-radius: 5px;
                                color: #fff;
                                cursor: pointer;
                                font-size: 14px;
                            ">❌ Отмена</button>
                        </div>
                    </div>
                </div>
            `;
            
            // Удаляем старое модальное окно, если есть (в целевом документе)
            const oldModal = targetDoc.querySelector('.lampasync-settings-modal');
            if (oldModal) {
                oldModal.remove();
            }
            
            // Добавляем модальное окно в целевой документ (top или текущий)
            targetDoc.body.insertAdjacentHTML('beforeend', modalHtml);
            
            const modal = targetDoc.querySelector('.lampasync-settings-modal');
            const saveBtn = targetDoc.getElementById('lampasync-save');
            const cancelBtn = targetDoc.getElementById('lampasync-cancel');
            const urlInput = targetDoc.getElementById('lampasync-server-url');
            const passwordInput = targetDoc.getElementById('lampasync-password');
            
            // Убеждаемся, что поля редактируемы и фокусируем первое поле
            if (urlInput) {
                urlInput.readOnly = false;
                urlInput.disabled = false;
                urlInput.removeAttribute('readonly');
                urlInput.removeAttribute('disabled');
                
                // КРИТИЧНО: Предотвращаем перехват событий клавиатуры Lampa
                // Lampa может перехватывать Backspace для навигации, нужно остановить это
                const urlInputKeyHandler = function(e) {
                    // Останавливаем распространение ВСЕХ событий клавиатуры
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    
                    // Для Backspace и Delete явно предотвращаем дефолтное поведение навигации
                    if (e.key === 'Backspace' || e.key === 'Delete') {
                        // Не вызываем preventDefault() для Backspace/Delete, чтобы они работали в поле ввода
                        // Но останавливаем распространение, чтобы Lampa не перехватила
                        return true;
                    }
                };
                
                // Используем capture phase (true) для перехвата ДО того, как Lampa обработает
                urlInput.addEventListener('keydown', urlInputKeyHandler, true);
                urlInput.addEventListener('keyup', function(e) {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }, true);
                urlInput.addEventListener('keypress', function(e) {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }, true);
                
                // Также перехватываем на уровне input для надёжности
                urlInput.addEventListener('input', function(e) {
                    e.stopPropagation();
                }, true);
                
                setTimeout(() => {
                    urlInput.focus();
                    urlInput.select();
                }, 100);
            }
            
            if (passwordInput) {
                passwordInput.readOnly = false;
                passwordInput.disabled = false;
                passwordInput.removeAttribute('readonly');
                passwordInput.removeAttribute('disabled');
                
                // Аналогично для поля пароля
                const passwordInputKeyHandler = function(e) {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    if (e.key === 'Backspace' || e.key === 'Delete') {
                        return true;
                    }
                };
                
                passwordInput.addEventListener('keydown', passwordInputKeyHandler, true);
                passwordInput.addEventListener('keyup', function(e) {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }, true);
                passwordInput.addEventListener('keypress', function(e) {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }, true);
                passwordInput.addEventListener('input', function(e) {
                    e.stopPropagation();
                }, true);
            }
            
            // Также предотвращаем перехват событий на уровне модального окна
            if (modal) {
                modal.addEventListener('keydown', function(e) {
                    // Если фокус на поле ввода, не перехватываем события
                    const activeElement = document.activeElement;
                    if (activeElement && (activeElement === urlInput || activeElement === passwordInput)) {
                        e.stopPropagation();
                    }
                }, true);
            }
            
            // Обработчик сохранения
            saveBtn.addEventListener('click', () => {
                const serverUrl = urlInput.value.trim();
                const password = passwordInput.value.trim();
                
                if (!serverUrl) {
                    alert('⚠️ Пожалуйста, укажите URL сервера');
                    return;
                }
                
                if (!password) {
                    alert('⚠️ Пожалуйста, укажите пароль');
                    return;
                }
                
                localStorage.setItem('lampa_sync_server_url', serverUrl);
                localStorage.setItem('lampa_sync_password', password);
                if (window.Lampa && window.Lampa.Storage) {
                    Lampa.Storage.set('lampa_sync_server_url', serverUrl);
                    Lampa.Storage.set('lampa_sync_password', password);
                }
                // Сразу переключаем конфиг на новый URL, чтобы следующие запросы не шли на localhost
                lastSavedServerUrl = serverUrl;
                lastSavedPassword = password;
                
                console.log('[Lampa Sync] ✅ Settings saved:', { serverUrl, password: '***' });
                alert('✅ Настройки сохранены! Плагин будет использовать новый URL.');
                
                modal.remove();
            });
            
            // Обработчик отмены
            cancelBtn.addEventListener('click', () => {
                modal.remove();
            });
            
            // Закрытие по клику вне модального окна
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.remove();
                }
            });
            
            // Закрытие по Escape
            const escapeHandler = (e) => {
                if (e.key === 'Escape') {
                    modal.remove();
                    document.removeEventListener('keydown', escapeHandler);
                }
            };
            document.addEventListener('keydown', escapeHandler);
            
        } catch (e) {
            console.error('[Lampa Sync] Error showing settings modal:', e);
            alert('Ошибка при открытии настроек. Используйте консоль браузера для настройки.');
        }
    }
    
    // Инициализация настроек (шаблон + меню)
    function initSettingsNew() {
        registerSettingsParams();
        if (window.Lampa && window.Lampa.Template) {
            initSettingsTemplate();
        } else {
            const checkTemplate = setInterval(() => {
                if (window.Lampa && window.Lampa.Template) {
                    clearInterval(checkTemplate);
                    registerSettingsParams();
                    initSettingsTemplate();
                }
            }, 500);
            setTimeout(() => clearInterval(checkTemplate), 10000);
        }

        function tryAddMenu() {
            if (window.Lampa && window.Lampa.Settings && window.Lampa.Settings.main) {
                addSettingsMenu();
            } else {
                setTimeout(tryAddMenu, 500);
            }
        }

        if (window.appready) {
            setTimeout(tryAddMenu, 500);
        } else if (window.Lampa && window.Lampa.Listener) {
            Lampa.Listener.follow('app', function (e) {
                if (e.type == 'ready') setTimeout(tryAddMenu, 500);
            });
        } else {
            const checkListener = setInterval(() => {
                if (window.Lampa && window.Lampa.Listener) {
                    clearInterval(checkListener);
                    Lampa.Listener.follow('app', function (e) {
                        if (e.type == 'ready') setTimeout(tryAddMenu, 500);
                    });
                }
            }, 500);
            setTimeout(() => clearInterval(checkListener), 10000);
        }
    }

    initSettingsNew();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startPlugin);
    } else {
        setTimeout(startPlugin, 1000);
    }

    /**
     * Функция для принудительной очистки всех настроек
     * Используйте в консоли: window.LampaSync.cleanSettings()
     */
    function cleanSettings() {
        try {
            console.log('[Lampa Sync] Starting full settings cleanup...');
            
            // Очищаем все ключи, которые являются URL
            const allKeys = Object.keys(localStorage);
            let cleanedCount = 0;
            allKeys.forEach(key => {
                if (key.startsWith('http://') || key.startsWith('https://')) {
                    console.log('[Lampa Sync] Removing:', key);
                    localStorage.removeItem(key);
                    cleanedCount++;
                }
            });
            
            // Удаляем наши параметры
            localStorage.removeItem('lampa_sync_server_url');
            localStorage.removeItem('lampa_sync_password');
            
            if (Lampa.Storage && Lampa.Storage.remove) {
                Lampa.Storage.remove('lampa_sync_server_url');
                Lampa.Storage.remove('lampa_sync_password');
            }
            
            // Устанавливаем значения по умолчанию
            localStorage.setItem('lampa_sync_server_url', 'http://localhost:3000');
            localStorage.setItem('lampa_sync_password', '');
            
            if (Lampa.Storage && Lampa.Storage.set) {
                Lampa.Storage.set('lampa_sync_server_url', 'http://localhost:3000');
                Lampa.Storage.set('lampa_sync_password', '');
            }
            
            console.log('[Lampa Sync] ✅ Cleanup complete. Removed', cleanedCount, 'invalid keys.');
            console.log('[Lampa Sync] Please reload the page: location.reload()');
            
            return {
                cleaned: cleanedCount,
                message: 'Settings cleaned. Please reload the page.'
            };
        } catch (e) {
            console.error('[Lampa Sync] Error during cleanup:', e);
            return {
                error: e.message
            };
        }
    }
    
    // Экспортируем функции для ручного управления (опционально)
    window.LampaSync = {
        loadProgress: loadProgress,
        saveProgress: saveProgress,
        syncAll: syncAll,
        pushFavorite: pushFavorite,
        getTmdbIdFromUrl: getTmdbIdFromUrl,
        getCurrentFileId: getCurrentFileId,
        getConfig: getConfig,
        getDeviceId: getDeviceId,
        showSettings: showSettingsModal,
        cleanSettings: cleanSettings,
        checkConnection: checkConnection
    };
    
    // Логируем для отладки
    console.log('[Lampa Sync] Exported functions:', Object.keys(window.LampaSync));
    console.log('[Lampa Sync] Device ID:', getDeviceId());
    
    window.LampaSyncCleanSettings = cleanSettings;
    
    // Только лог в консоль, без автопоказа модалки
    setTimeout(() => {
        const config = getConfig();
        const hasPassword = config.SYNC_PASSWORD && String(config.SYNC_PASSWORD).trim().length > 0;
        if (!hasPassword) {
            console.log('[Lampa Sync] Пароль не задан. Настройка: window.LampaSync.showSettings() или Настройки → Синхронизация прогресса');
        } else if (isLocalhostUrl(config.SYNC_SERVER_URL) && isCorsRestrictedOrigin()) {
            console.warn('[Lampa Sync] Для удалённого сайта укажите публичный URL сервера (не localhost): window.LampaSync.showSettings()');
        }
    }, 800);

})();
