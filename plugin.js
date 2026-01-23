/**
 * Lampa Sync Plugin
 * @author kotopheiop
 * @name Синхронизация прогресса просмотра
 * @description Синхронизация прогресса просмотра и избранного между устройствами через сервер
 */

(function() {
    'use strict';

    // Проверка на дублирование плагина
    if (window.lampasyncplugin) return;
    window.lampasyncplugin = true;

    // ==================== КОНСТАНТЫ ====================
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

    // ==================== КОНФИГУРАЦИЯ ====================
    
    /**
     * Получение конфигурации из настроек Lampa
     */
    function getConfig() {
        // Пробуем получить через Lampa.Storage, если доступен
        let serverUrl = 'http://localhost:3000';
        let password = '';
        
        if (window.Lampa && window.Lampa.Storage) {
            serverUrl = Lampa.Storage.get('lampa_sync_server_url') || serverUrl;
            password = Lampa.Storage.get('lampa_sync_password') || password;
        } else {
            // Fallback на localStorage
            try {
                const storedUrl = localStorage.getItem('lampa_sync_server_url');
                const storedPassword = localStorage.getItem('lampa_sync_password');
                if (storedUrl) serverUrl = storedUrl;
                if (storedPassword) password = storedPassword;
            } catch (e) {
                console.warn('[Lampa Sync] Error reading config from localStorage:', e);
            }
        }
        
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
     * Получение значения из localStorage
     */
    function getStorage(key, defaultValue = null) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : defaultValue;
        } catch (e) {
            console.error('[Lampa Sync] Error reading localStorage:', e);
            return defaultValue;
        }
    }

    /**
     * Сохранение значения в localStorage
     */
    function setStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('[Lampa Sync] Error writing localStorage:', e);
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
     * Получение текущего file_id из плеера
     */
    function getCurrentFileId() {
        try {
            // Способ 1: Через Lampa.Player
            if (window.Lampa && window.Lampa.Player) {
                const player = window.Lampa.Player;
                if (player.file_id) return player.file_id;
                if (player.file && player.file.id) return player.file.id;
            }
            
            // Способ 2: Через file_view - находим самый свежий (с наибольшим time)
            const fileView = getStorage('file_view', {});
            const keys = Object.keys(fileView);
            if (keys.length > 0) {
                // Сортируем по времени и возвращаем последний активный
                const sorted = keys.sort((a, b) => {
                    const timeA = fileView[a]?.time || 0;
                    const timeB = fileView[b]?.time || 0;
                    return timeB - timeA;
                });
                return sorted[0];
            }
            
            // Способ 3: Через URL параметры (если есть)
            try {
                const urlParams = new URLSearchParams(window.location.search);
                const fileId = urlParams.get('file_id');
                if (fileId) return fileId;
            } catch (e) {
                // Игнорируем ошибки парсинга URL
            }
            
            return null;
        } catch (e) {
            console.error('[Lampa Sync] Error getting file_id:', e);
            return null;
        }
    }

    /**
     * Получение индекса в favorite.card по TMDB ID
     */
    function getFavoriteIndex(tmdbId) {
        try {
            const favorite = getStorage('favorite', {});
            const cardArray = favorite.card || [];
            return cardArray.indexOf(tmdbId);
        } catch (e) {
            console.error('[Lampa Sync] Error getting favorite index:', e);
            return -1;
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
                    throw new Error('Unauthorized: Check SYNC_PASSWORD in settings');
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
            // Определяем тип ошибки для более информативного сообщения
            const errorMessage = e.message || String(e);
            
            if (errorMessage.includes('ERR_CONNECTION_REFUSED') || errorMessage.includes('Failed to fetch')) {
                // Ошибка подключения - сервер не запущен или недоступен
                const errorMsg = 'Connection refused: Server is not running or not accessible. ' +
                    'Make sure the server is started and listening on 0.0.0.0 (not just localhost).';
                console.warn('[Lampa Sync]', errorMsg);
                throw new Error(errorMsg);
            } else if (errorMessage.includes('CORS') || errorMessage.includes('blocked by CORS')) {
                // Ошибка CORS
                const errorMsg = 'CORS error: Server may not be accessible from this origin. ' +
                    'If using localhost, try using your local IP address (e.g., http://192.168.1.100:3000) or set up CORS on the server.';
                console.warn('[Lampa Sync]', errorMsg);
                throw new Error(errorMsg);
            }
            
            console.error('[Lampa Sync] API request error:', e);
            throw e;
        }
    }

    /**
     * Ожидание появления file_view
     */
    function waitForFileView(fileId, timeout) {
        const config = getConfig();
        const actualTimeout = timeout || config.FILE_VIEW_TIMEOUT;
        
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkInterval = setInterval(() => {
                const fileView = getStorage('file_view', {});
                
                if (fileView[fileId]) {
                    clearInterval(checkInterval);
                    resolve(fileView[fileId]);
                } else if (Date.now() - startTime > actualTimeout) {
                    clearInterval(checkInterval);
                    reject(new Error('Timeout waiting for file_view'));
                }
            }, 100);
        });
    }

    // ==================== СИНХРОНИЗАЦИЯ ====================

    /**
     * Загрузка прогресса с сервера
     */
    async function loadProgress(tmdbId) {
        try {
            console.log('[Lampa Sync] Loading progress for TMDB:', tmdbId);
            
            const data = await apiRequest(`/progress?tmdb=${tmdbId}`);
            
            if (!data) {
                console.log('[Lampa Sync] No progress found on server');
                return null;
            }

            console.log('[Lampa Sync] Progress loaded:', data);

            const config = getConfig();

            // Обновляем file_view
            const fileId = getCurrentFileId();
            if (fileId && data.time !== undefined && data.percent !== undefined) {
                const fileView = getStorage('file_view', {});
                
                if (fileView[fileId]) {
                    // Обновляем только если время > MIN_SEEK_TIME
                    if (data.time >= config.MIN_SEEK_TIME) {
                        fileView[fileId].time = data.time;
                        fileView[fileId].percent = data.percent;
                        setStorage('file_view', fileView);
                        console.log('[Lampa Sync] file_view updated');
                    }
                }
            }

            // Синхронизируем favorite
            if (data.favorite) {
                const currentFavorite = getStorage('favorite', {});
                const mergedFavorite = mergeFavorite(currentFavorite, data.favorite);
                setStorage('favorite', mergedFavorite);
                console.log('[Lampa Sync] favorite synchronized');
            }

            return data;
        } catch (e) {
            console.error('[Lampa Sync] Error loading progress:', e);
            return null;
        }
    }

    /**
     * Сохранение прогресса на сервер
     */
    async function saveProgress(tmdbId, fileId) {
        try {
            const config = getConfig();
            
            const fileView = getStorage('file_view', {});
            const favorite = getStorage('favorite', {});
            
            if (!fileView[fileId]) {
                console.log('[Lampa Sync] No file_view found for file_id:', fileId);
                return;
            }

            const progress = fileView[fileId];
            
            // Пропускаем если прогресс > REMOVE_AT_PERCENT
            if (progress.percent >= config.REMOVE_AT_PERCENT) {
                console.log('[Lampa Sync] Progress > 95%, skipping save');
                return;
            }

            // Проверяем размер favorite перед отправкой
            const favoriteSize = JSON.stringify(favorite).length;
            const maxSize = 10 * 1024 * 1024; // 10MB
            
            if (favoriteSize > maxSize) {
                console.warn('[Lampa Sync] Favorite object is too large:', favoriteSize, 'bytes. Sending only essential data.');
                // Отправляем только минимально необходимые данные
                const minimalFavorite = {
                    card: favorite.card || [],
                    like: favorite.like || [],
                    watch: favorite.watch || [],
                    book: favorite.book || [],
                    history: favorite.history || [],
                    look: favorite.look || [],
                    viewed: favorite.viewed || [],
                    scheduled: favorite.scheduled || [],
                    continued: favorite.continued || [],
                    thrown: favorite.thrown || []
                };
                
                const payload = {
                    tmdb: tmdbId,
                    time: progress.time || 0,
                    percent: progress.percent || 0,
                    favorite: minimalFavorite
                };
                
                console.log('[Lampa Sync] Saving progress with minimal favorite (size:', JSON.stringify(minimalFavorite).length, 'bytes)');
                const result = await apiRequest('/progress', 'POST', payload);
                console.log('[Lampa Sync] Progress saved:', result);
                return result;
            }

            const payload = {
                tmdb: tmdbId,
                time: progress.time || 0,
                percent: progress.percent || 0,
                favorite: favorite
            };

            console.log('[Lampa Sync] Saving progress (favorite size:', favoriteSize, 'bytes)');
            
            const result = await apiRequest('/progress', 'POST', payload);
            console.log('[Lampa Sync] Progress saved:', result);
            
            return result;
        } catch (e) {
            const errorMsg = e.message || String(e);
            if (errorMsg.includes('413') || errorMsg.includes('too large')) {
                console.error('[Lampa Sync] Request too large. Try reducing favorite size or increase server limit.');
                console.error('[Lampa Sync] Error details:', errorMsg);
            } else {
                console.error('[Lampa Sync] Error saving progress:', e);
            }
        }
    }

    /**
     * Объединение объектов favorite
     */
    function mergeFavorite(current, server) {
        if (!server) return current;
        if (!current) return server;

        const merged = { ...current };
        const arraysToMerge = ['card', 'like', 'watch', 'book', 'history', 'look', 'viewed', 'scheduled', 'continued', 'thrown'];

        arraysToMerge.forEach(key => {
            const currentArray = current[key] || [];
            const serverArray = server[key] || [];
            merged[key] = [...new Set([...currentArray, ...serverArray])];
        });

        return merged;
    }

    // ==================== ОБРАБОТЧИКИ СОБЫТИЙ ====================

    let syncTimeout = null;
    let currentTmdbId = null;
    let currentFileId = null;
    let lastSavedTime = 0;

    /**
     * Обработчик события start
     */
    async function handleStart() {
        console.log('[Lampa Sync] Player started');
        
        // Очищаем предыдущий таймаут
        if (syncTimeout) {
            clearTimeout(syncTimeout);
            syncTimeout = null;
        }

        // Получаем TMDB ID из URL
        const tmdbId = getTmdbIdFromUrl();
        if (!tmdbId) {
            console.log('[Lampa Sync] No TMDB ID in URL, skipping sync');
            return;
        }

        currentTmdbId = tmdbId;

        // Получаем file_id
        let fileId = getCurrentFileId();
        
        // Если file_id не найден сразу, ждём появления file_view
        if (!fileId) {
            console.log('[Lampa Sync] No file_id found, waiting for file_view...');
            
            // Пробуем найти file_id через несколько попыток
            for (let i = 0; i < 10; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));
                fileId = getCurrentFileId();
                if (fileId) break;
            }
            
            if (!fileId) {
                console.warn('[Lampa Sync] file_id not found after waiting, will try later');
                // Продолжаем без file_id - загрузим прогресс позже
            }
        }
        
        currentFileId = fileId;

        // Загружаем прогресс с сервера (даже если file_id ещё не найден)
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
            if (currentTmdbId && currentFileId) {
                await saveProgress(currentTmdbId, currentFileId);
                lastSavedTime = Date.now();
            }
        }, config.SYNC_DELAY);
    }

    // ==================== ИНИЦИАЛИЗАЦИЯ ====================

    /**
     * Инициализация плагина
     */
    function startPlugin() {
        console.log('[Lampa Sync] Plugin initialized by @kotopheiop');
        
        const config = getConfig();
        console.log('[Lampa Sync] Server URL:', config.SYNC_SERVER_URL);
        
        // Проверяем наличие пароля
        if (!config.SYNC_PASSWORD) {
            console.warn('[Lampa Sync] SYNC_PASSWORD not configured. Please set it in Lampa settings (Настройки → Интерфейс → Синхронизация прогресса).');
        } else {
            // Проверяем доступность сервера
            apiRequest('/health')
                .then(data => {
                    console.log('[Lampa Sync] ✅ Server is available:', data);
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

        // Отслеживаем изменения в localStorage для определения событий плеера
        let lastFileView = getStorage('file_view', {});
        let lastFileViewTime = {};
        let lastUrl = window.location.href;
        
        // Функция для отслеживания изменений
        function trackChanges() {
            const currentFileView = getStorage('file_view', {});
            const currentUrl = window.location.href;
            const currentFileViewKeys = Object.keys(currentFileView);
            const lastFileViewKeys = Object.keys(lastFileView);
            
            // Проверяем изменение URL (новый фильм = start)
            if (currentUrl !== lastUrl) {
                const tmdbId = getTmdbIdFromUrl();
                if (tmdbId) {
                    console.log('[Lampa Sync] URL changed, new movie detected');
                    handleStart();
                }
                lastUrl = currentUrl;
            }
            
            // Если появился новый file_view, это start
            if (currentFileViewKeys.length > lastFileViewKeys.length) {
                console.log('[Lampa Sync] New file_view detected');
                handleStart();
            }
            
            // Отслеживаем изменения времени в существующих file_view (пауза/остановка)
            currentFileViewKeys.forEach(fileId => {
                const currentTime = currentFileView[fileId]?.time || 0;
                const lastTime = lastFileViewTime[fileId] || 0;
                
                // Если время не изменилось, но было > 0, возможно пауза
                if (currentTime > 0 && currentTime === lastTime && lastTime > 0) {
                    // Проверяем, не изменилось ли время последний раз более 3 секунд назад
                    // Это может означать паузу
                    const timeSinceLastChange = Date.now() - (lastFileViewTime[fileId + '_timestamp'] || 0);
                    if (timeSinceLastChange > 3000 && timeSinceLastChange < 10000) {
                        console.log('[Lampa Sync] Possible pause detected');
                        handleSave();
                    }
                }
                
                // Сохраняем текущее время
                if (currentTime !== lastTime) {
                    lastFileViewTime[fileId] = currentTime;
                    lastFileViewTime[fileId + '_timestamp'] = Date.now();
                }
            });
            
            lastFileView = JSON.parse(JSON.stringify(currentFileView)); // Глубокая копия
        }
        
        // Отслеживаем изменения каждые 2 секунды
        setInterval(trackChanges, 2000);
        
        // Слушаем события страницы
        window.addEventListener('beforeunload', () => {
            handleSave();
        });
        
        // Отслеживаем изменения URL через History API
        let originalPushState = history.pushState;
        history.pushState = function() {
            originalPushState.apply(history, arguments);
            setTimeout(() => {
                const tmdbId = getTmdbIdFromUrl();
                if (tmdbId) {
                    console.log('[Lampa Sync] History changed, new movie detected');
                    handleStart();
                }
            }, 500);
        };

        // Периодическое автосохранение (каждые 30 секунд во время просмотра)
        setInterval(() => {
            if (currentTmdbId && currentFileId) {
                const config = getConfig();
                const fileView = getStorage('file_view', {});
                if (fileView[currentFileId]) {
                    // Сохраняем только если есть активный просмотр
                    const progress = fileView[currentFileId];
                    if (progress && progress.time > config.MIN_SEEK_TIME) {
                        // Сохраняем только если прошло более 30 секунд с последнего сохранения
                        if (Date.now() - lastSavedTime > 30000) {
                            saveProgress(currentTmdbId, currentFileId).catch(e => {
                                console.error('[Lampa Sync] Auto-save error:', e);
                            });
                            lastSavedTime = Date.now();
                        }
                    }
                }
            }
        }, 30000); // Каждые 30 секунд

        // Обновляем currentFileId периодически (на случай если он появился позже)
        setInterval(() => {
            if (currentTmdbId && !currentFileId) {
                const fileId = getCurrentFileId();
                if (fileId) {
                    currentFileId = fileId;
                    console.log('[Lampa Sync] file_id found:', fileId);
                    // Загружаем прогресс, если ещё не загружали
                    loadProgress(currentTmdbId).catch(e => {
                        console.error('[Lampa Sync] Delayed load error:', e);
                    });
                }
            }
        }, 2000);
    }

    // ==================== НАСТРОЙКИ LAMPA ====================
    
    // Функция для добавления настроек
    function addSettings() {
        try {
            if (!window.Lampa) {
                console.log('[Lampa Sync] Lampa object not available');
                return false;
            }
            
            if (!window.Lampa.SettingsApi) {
                console.log('[Lampa Sync] Lampa.SettingsApi not available');
                return false;
            }
            
            if (typeof Lampa.SettingsApi.addParam !== 'function') {
                console.log('[Lampa Sync] Lampa.SettingsApi.addParam is not a function');
                console.log('[Lampa Sync] Available methods:', Object.keys(Lampa.SettingsApi || {}));
                return false;
            }
            
            // Пробуем разные варианты типов
            const textTypes = ['text', 'string', 'input'];
            let successCount = 0;
            
            // Пробуем добавить URL сервера
            for (let textType of textTypes) {
                try {
                    Lampa.SettingsApi.addParam({
                        component: 'interface',
                        param: {
                            name: 'lampa_sync_server_url',
                            type: textType,
                            default: 'http://localhost:3000',
                        },
                        field: {
                            name: 'URL сервера синхронизации',
                            description: 'Адрес сервера для синхронизации прогресса (например: http://localhost:3000 или https://your-domain.com)',
                        }
                    });
                    console.log('[Lampa Sync] URL setting added with type:', textType);
                    successCount++;
                    break; // Успешно добавили, выходим
                } catch (e) {
                    // Пробуем следующий тип
                    continue;
                }
            }
            
            // Пробуем добавить пароль
            for (let textType of textTypes) {
                try {
                    Lampa.SettingsApi.addParam({
                        component: 'interface',
                        param: {
                            name: 'lampa_sync_password',
                            type: textType,
                            default: '',
                        },
                        field: {
                            name: 'Пароль синхронизации',
                            description: 'Пароль для авторизации на сервере (должен совпадать с SYNC_PASSWORD в .env сервера)',
                        }
                    });
                    console.log('[Lampa Sync] Password setting added with type:', textType);
                    successCount++;
                    break; // Успешно добавили, выходим
                } catch (e) {
                    // Пробуем следующий тип
                    continue;
                }
            }
            
            if (successCount === 2) {
                console.log('[Lampa Sync] ✅ Settings successfully added to Lampa interface');
                return true;
            } else if (successCount === 1) {
                console.warn('[Lampa Sync] ⚠️ Only one setting was added');
                return true;
            } else {
                console.error('[Lampa Sync] ❌ Failed to add settings with any text type');
                console.log('[Lampa Sync] Available SettingsApi methods:', Object.keys(Lampa.SettingsApi));
                return false;
            }
        } catch (e) {
            console.error('[Lampa Sync] Error adding settings:', e);
            console.error('[Lampa Sync] Error stack:', e.stack);
            return false;
        }
    }
    
    // Пробуем добавить настройки несколько раз с задержками
    let settingsAttempts = 0;
    const maxSettingsAttempts = 30; // 15 секунд максимум
    
    function tryAddSettings() {
        if (addSettings()) {
            console.log('[Lampa Sync] ✅ Settings successfully added to interface');
        } else {
            settingsAttempts++;
            if (settingsAttempts < maxSettingsAttempts) {
                setTimeout(tryAddSettings, 500);
            } else {
                console.warn('[Lampa Sync] ⚠️ Failed to add settings to interface after', maxSettingsAttempts, 'attempts');
                console.warn('[Lampa Sync] This may mean that Lampa does not support text input fields in settings.');
                console.warn('[Lampa Sync] You can manually configure the plugin by running these commands in browser console:');
                console.warn('');
                console.warn('  localStorage.setItem("lampa_sync_server_url", "http://localhost:3000");');
                console.warn('  localStorage.setItem("lampa_sync_password", "yourpassword");');
                console.warn('  location.reload(); // Перезагрузите страницу');
                console.warn('');
                console.warn('[Lampa Sync] Or use window.LampaSync.getConfig() to check current settings');
            }
        }
    }
    
    // Начинаем попытки добавления настроек после загрузки Lampa
    // Используем несколько стратегий для максимальной совместимости
    function initSettings() {
        // Стратегия 1: Если Lampa уже загружен
        if (window.Lampa && window.Lampa.SettingsApi) {
            setTimeout(tryAddSettings, 500);
            return;
        }
        
        // Стратегия 2: Ждём события загрузки
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                setTimeout(tryAddSettings, 1500);
            });
        } else {
            // Стратегия 3: Пробуем через интервалы
            setTimeout(tryAddSettings, 1500);
        }
        
        // Стратегия 4: Слушаем появление Lampa
        let checkLampa = setInterval(function() {
            if (window.Lampa && window.Lampa.SettingsApi) {
                clearInterval(checkLampa);
                tryAddSettings();
            }
        }, 500);
        
        // Останавливаем проверку через 10 секунд
        setTimeout(function() {
            clearInterval(checkLampa);
        }, 10000);
    }
    
    // Запускаем инициализацию настроек
    initSettings();

    // Запускаем плагин
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startPlugin);
    } else {
        // DOM уже загружен
        setTimeout(startPlugin, 1000); // Даём время Lampa загрузиться
    }

    // Экспортируем функции для ручного управления (опционально)
    window.LampaSync = {
        loadProgress,
        saveProgress,
        getTmdbIdFromUrl,
        getCurrentFileId,
        getConfig
    };

})();
