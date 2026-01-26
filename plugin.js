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
            // Пробуем найти правильный file_id через маппинг с сервера
            let fileId = getCurrentFileId();
            
            // Если есть маппинг с сервера, пробуем найти file_id по tmdb
            if (data.file_mapping && tmdbId) {
                // Ищем file_id, который соответствует этому tmdb
                for (const [fid, tmdb] of Object.entries(data.file_mapping)) {
                    if (tmdb === tmdbId) {
                        fileId = fid;
                        console.log('[Lampa Sync] Found file_id from mapping:', fileId, 'for tmdb:', tmdbId);
                        break;
                    }
                }
            }
            
            // Если file_id не найден, пробуем найти по порядку в favorite.card
            if (!fileId) {
                const favorite = getStorage('favorite', {});
                const cardArray = favorite.card || [];
                const tmdbIndex = cardArray.indexOf(tmdbId);
                
                if (tmdbIndex >= 0) {
                    const fileView = getStorage('file_view', {});
                    const fileViewKeys = Object.keys(fileView);
                    
                    // Предполагаем, что порядок file_view соответствует порядку favorite.card
                    if (fileViewKeys.length > tmdbIndex) {
                        fileId = fileViewKeys[tmdbIndex];
                        console.log('[Lampa Sync] Found file_id by index:', fileId, 'at index', tmdbIndex);
                    }
                }
            }
            
            if (fileId && data.time !== undefined && data.percent !== undefined) {
                const fileView = getStorage('file_view', {});
                
                if (fileView[fileId]) {
                    // Обновляем только если время > MIN_SEEK_TIME
                    if (data.time >= config.MIN_SEEK_TIME) {
                        const oldTime = fileView[fileId].time || 0;
                        const oldPercent = fileView[fileId].percent || 0;
                        
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
                        
                        // Обновляем UI после изменения прогресса
                        updateUIAfterProgressChange(fileId, tmdbId);
                    }
                } else {
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
                            // Обновляем элементы, которые показывают время или процент
                            const text = el.textContent || '';
                            if (text.match(/\d+%/) || text.match(/\d+\s*мин/) || text.match(/\d+\s*:\d+/)) {
                                // Обновляем текст прогресса
                                if (progress.percent > 0) {
                                    el.textContent = progress.percent + '%';
                                }
                            }
                            
                            // Обновляем прогресс-бары
                            if (el.style) {
                                el.style.width = progress.percent + '%';
                            }
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
            
            let finalTime = progress.time || 0;
            let finalPercent = progress.percent || 0;
            
            // Пробуем получить актуальное время из video элемента (только для встроенного плеера)
            const usingExternalPlayer = isExternalPlayer();
            if (!usingExternalPlayer) {
                const playbackTime = getCurrentPlaybackTime();
                
                if (playbackTime !== null && playbackTime > 0) {
                    // Используем время из video элемента, если оно больше
                    if (playbackTime > finalTime) {
                        finalTime = playbackTime;
                        // Вычисляем процент, если есть duration
                        if (progress.duration && progress.duration > 0) {
                            finalPercent = Math.round((finalTime / progress.duration) * 100);
                        } else if (progress.percent) {
                            // Используем старый процент, если duration неизвестен
                            finalPercent = progress.percent;
                        }
                        
                        // Обновляем file_view с актуальным временем
                        fileView[fileId].time = finalTime;
                        fileView[fileId].percent = finalPercent;
                        setStorage('file_view', fileView);
                        
                        console.log('[Lampa Sync] Updated time from video element:', {
                            oldTime: progress.time,
                            newTime: finalTime,
                            percent: finalPercent
                        });
                    }
                }
            } else {
                // Для внешних плееров используем время из file_view
                // Lampa обновляет его при возврате из внешнего плеера
                console.log('[Lampa Sync] Using external player, time from file_view:', finalTime);
            }
            
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
                    time: finalTime,
                    percent: finalPercent,
                    favorite: minimalFavorite,
                    file_id: fileId // Отправляем file_id для маппинга на сервере
                };
                
                console.log('[Lampa Sync] Saving progress with minimal favorite (size:', JSON.stringify(minimalFavorite).length, 'bytes, file_id:', fileId, ', tmdb:', tmdbId, ')');
                const result = await apiRequest('/progress', 'POST', payload);
                console.log('[Lampa Sync] Progress saved:', result);
                return result;
            }

            const payload = {
                tmdb: tmdbId,
                time: finalTime,
                percent: finalPercent,
                favorite: favorite,
                file_id: fileId // Отправляем file_id для маппинга на сервере
            };

            console.log('[Lampa Sync] Saving progress (favorite size:', favoriteSize, 'bytes, file_id:', fileId, ', tmdb:', tmdbId, ', time:', finalTime, ', percent:', finalPercent, ')');
            
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
    let pendingProgress = null; // Сохраняем прогресс, если file_id ещё не найден
    let lastFileViewTime = {}; // Отслеживание времени file_view для предотвращения дублирования

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
        
        // Если file_id не найден сразу, пробуем найти по индексу в favorite.card
        if (!fileId) {
            const favorite = getStorage('favorite', {});
            const cardArray = favorite.card || [];
            const tmdbIndex = cardArray.indexOf(tmdbId);
            
            if (tmdbIndex >= 0) {
                const fileView = getStorage('file_view', {});
                const fileViewKeys = Object.keys(fileView);
                
                // Предполагаем, что порядок file_view соответствует порядку favorite.card
                if (fileViewKeys.length > tmdbIndex) {
                    fileId = fileViewKeys[tmdbIndex];
                    console.log('[Lampa Sync] Found file_id by favorite.card index:', fileId, 'at index', tmdbIndex);
                }
            }
        }
        
        // Если file_id всё ещё не найден, ждём появления file_view
        if (!fileId) {
            console.log('[Lampa Sync] No file_id found, waiting for file_view...');
            
            // Пробуем найти file_id через несколько попыток
            for (let i = 0; i < 10; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));
                fileId = getCurrentFileId();
                
                // Также пробуем найти по индексу
                if (!fileId) {
                    const favorite = getStorage('favorite', {});
                    const cardArray = favorite.card || [];
                    const tmdbIndex = cardArray.indexOf(tmdbId);
                    
                    if (tmdbIndex >= 0) {
                        const fileView = getStorage('file_view', {});
                        const fileViewKeys = Object.keys(fileView);
                        if (fileViewKeys.length > tmdbIndex) {
                            fileId = fileViewKeys[tmdbIndex];
                        }
                    }
                }
                
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
        // Используем глобальную переменную lastFileViewTime, объявленную выше
        if (Object.keys(lastFileViewTime).length === 0) {
            // Инициализируем только если пусто
            lastFileViewTime = {};
        }
        let lastUrl = window.location.href;
        let lastTmdbId = null;
        
        // Функция для проверки и загрузки прогресса при изменении TMDB ID
        function checkAndSyncProgress() {
            const urlTmdbId = getTmdbIdFromUrl();
            
            // Если TMDB ID изменился, загружаем прогресс
            if (urlTmdbId && urlTmdbId !== lastTmdbId) {
                console.log('[Lampa Sync] TMDB ID changed:', lastTmdbId, '->', urlTmdbId);
                lastTmdbId = urlTmdbId;
                currentTmdbId = urlTmdbId; // Обновляем глобальную переменную
                handleStart();
            }
        }
        
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
                    console.log('[Lampa Sync] URL changed, new movie detected:', tmdbId);
                    lastTmdbId = tmdbId;
                    handleStart();
                }
                lastUrl = currentUrl;
            } else {
                // Даже если URL не изменился, проверяем TMDB ID (может измениться параметр)
                checkAndSyncProgress();
            }
            
            // Если появился новый file_view, это start
            if (currentFileViewKeys.length > lastFileViewKeys.length) {
                console.log('[Lampa Sync] New file_view detected');
                checkAndSyncProgress();
                handleStart();
            }
            
            // Отслеживаем изменения времени в существующих file_view
            // И обновляем время из video элемента для активного просмотра (если доступно)
            currentFileViewKeys.forEach(fileId => {
                const currentProgress = currentFileView[fileId];
                let currentTime = currentProgress?.time || 0;
                let currentPercent = currentProgress?.percent || 0;
                const lastTime = lastFileViewTime[fileId] || 0;
                const lastPercent = lastFileViewTime[fileId + '_percent'] || 0;
                
                // Если это текущий просматриваемый файл
                if (fileId === currentFileId && currentTmdbId) {
                    const usingExternalPlayer = isExternalPlayer();
                    
                    if (!usingExternalPlayer) {
                        // Для встроенного плеера получаем актуальное время из video
                        const playbackTime = getCurrentPlaybackTime();
                        
                        // Если получили время из video элемента, обновляем file_view
                        if (playbackTime !== null && playbackTime > 0) {
                            const config = getConfig();
                            if (playbackTime >= config.MIN_SEEK_TIME) {
                                // Обновляем file_view с актуальным временем
                                if (playbackTime > currentTime) {
                                    currentTime = playbackTime;
                                    // Вычисляем процент, если есть duration
                                    if (currentProgress.duration && currentProgress.duration > 0) {
                                        currentPercent = Math.round((currentTime / currentProgress.duration) * 100);
                                    }
                                    
                                    // Обновляем localStorage
                                    const fileView = getStorage('file_view', {});
                                    fileView[fileId].time = currentTime;
                                    fileView[fileId].percent = currentPercent;
                                    setStorage('file_view', fileView);
                                    
                                    // Обновляем текущий объект для дальнейшей обработки
                                    currentFileView[fileId].time = currentTime;
                                    currentFileView[fileId].percent = currentPercent;
                                }
                            }
                        }
                    } else {
                        // Для внешних плееров полагаемся на обновления file_view от Lampa
                        // Lampa обновляет file_view при возврате из внешнего плеера
                        // Просто используем время из file_view как есть
                    }
                    
                    // Если время изменилось - это активный просмотр
                    if (currentTime !== lastTime && currentTime > 0) {
                        const config = getConfig();
                        // Сохраняем только если время больше минимального для seek
                        if (currentTime >= config.MIN_SEEK_TIME) {
                            // Дебаунс: сохраняем через 5 секунд после последнего изменения
                            if (syncTimeout) {
                                clearTimeout(syncTimeout);
                            }
                            syncTimeout = setTimeout(() => {
                                if (currentTmdbId && currentFileId) {
                                    console.log('[Lampa Sync] Auto-saving progress:', {
                                        tmdb: currentTmdbId,
                                        fileId: currentFileId,
                                        time: currentTime,
                                        percent: currentPercent
                                    });
                                    saveProgress(currentTmdbId, currentFileId).catch(e => {
                                        console.error('[Lampa Sync] Auto-save error:', e);
                                    });
                                    lastSavedTime = Date.now();
                                }
                            }, 5000); // Сохраняем через 5 секунд после изменения
                        }
                    }
                    
                    // Если время не изменилось, но было > 0, возможно пауза
                    // Но сохраняем только один раз при обнаружении паузы, не постоянно
                    if (currentTime > 0 && currentTime === lastTime && lastTime > 0) {
                        const timeSinceLastChange = Date.now() - (lastFileViewTime[fileId + '_timestamp'] || 0);
                        const pauseDetectedKey = fileId + '_pause_detected';
                        const lastPauseDetected = lastFileViewTime[pauseDetectedKey] || 0;
                        
                        // Если время не менялось более 3 секунд - это пауза
                        // Но сохраняем только если ещё не сохраняли для этой паузы
                        if (timeSinceLastChange > 3000 && (Date.now() - lastPauseDetected) > 10000) {
                            console.log('[Lampa Sync] Pause detected (time unchanged for', Math.round(timeSinceLastChange/1000), 'seconds)');
                            lastFileViewTime[pauseDetectedKey] = Date.now();
                            handleSave();
                        }
                    } else {
                        // Если время изменилось, сбрасываем флаг паузы
                        const pauseDetectedKey = fileId + '_pause_detected';
                        if (lastFileViewTime[pauseDetectedKey]) {
                            delete lastFileViewTime[pauseDetectedKey];
                        }
                    }
                }
                
                // Сохраняем текущее время и процент
                if (currentTime !== lastTime || currentPercent !== lastPercent) {
                    lastFileViewTime[fileId] = currentTime;
                    lastFileViewTime[fileId + '_percent'] = currentPercent;
                    lastFileViewTime[fileId + '_timestamp'] = Date.now();
                }
            });
            
            lastFileView = JSON.parse(JSON.stringify(currentFileView)); // Глубокая копия
        }
        
        // Отслеживаем изменения каждые 1 секунду (более часто для быстрой синхронизации)
        setInterval(trackChanges, 1000);
        
        // Используем Lampa.Listener для отслеживания открытия карточек (как в примере плагина)
        if (window.Lampa && window.Lampa.Listener) {
            try {
                Lampa.Listener.follow('full', function(e) {
                    if (e.type === 'complite') {
                        const tmdbId = getTmdbIdFromUrl();
                        if (tmdbId && tmdbId !== lastTmdbId) {
                            console.log('[Lampa Sync] Card opened via Lampa.Listener, TMDB:', tmdbId);
                            lastTmdbId = tmdbId;
                            // Небольшая задержка для появления file_view
                            setTimeout(() => {
                                handleStart();
                            }, 500);
                        }
                    }
                });
                console.log('[Lampa Sync] Lampa.Listener registered for card opening');
            } catch (e) {
                console.warn('[Lampa Sync] Could not register Lampa.Listener:', e);
            }
        }
        
        // Дополнительная проверка при открытии карточки - даже без запуска плеера
        // Проверяем наличие TMDB ID в URL каждую секунду
        setInterval(() => {
            const tmdbId = getTmdbIdFromUrl();
            if (tmdbId && tmdbId !== lastTmdbId) {
                console.log('[Lampa Sync] 🔄 TMDB ID detected in URL (card opened):', tmdbId);
                lastTmdbId = tmdbId;
                currentTmdbId = tmdbId; // Обновляем глобальную переменную
                
                // Пробуем найти file_id сразу
                let fileId = getCurrentFileId();
                if (!fileId) {
                    // Пробуем найти по индексу в favorite.card
                    const favorite = getStorage('favorite', {});
                    const cardArray = favorite.card || [];
                    const tmdbIndex = cardArray.indexOf(tmdbId);
                    
                    if (tmdbIndex >= 0) {
                        const fileView = getStorage('file_view', {});
                        const fileViewKeys = Object.keys(fileView);
                        if (fileViewKeys.length > tmdbIndex) {
                            fileId = fileViewKeys[tmdbIndex];
                            console.log('[Lampa Sync] Found file_id by index on card open:', fileId);
                        }
                    }
                }
                
                if (fileId) {
                    currentFileId = fileId;
                }
                
                // Загружаем прогресс сразу, даже если плеер не запущен
                // Это позволит синхронизировать favorite и подготовить file_view
                loadProgress(tmdbId).then(() => {
                    console.log('[Lampa Sync] ✅ Progress loaded on card open');
                }).catch(e => {
                    console.error('[Lampa Sync] Error loading progress on card open:', e);
                });
            }
        }, 1000);
        
        // Слушаем события страницы
        window.addEventListener('beforeunload', () => {
            handleSave();
        });
        
        // Отслеживаем изменения URL через History API
        let originalPushState = history.pushState;
        let originalReplaceState = history.replaceState;
        
        history.pushState = function() {
            originalPushState.apply(history, arguments);
            setTimeout(() => {
                const tmdbId = getTmdbIdFromUrl();
                if (tmdbId && tmdbId !== lastTmdbId) {
                    console.log('[Lampa Sync] History.pushState - new movie detected:', tmdbId);
                    lastTmdbId = tmdbId;
                    handleStart();
                }
            }, 300);
        };
        
        history.replaceState = function() {
            originalReplaceState.apply(history, arguments);
            setTimeout(() => {
                const tmdbId = getTmdbIdFromUrl();
                if (tmdbId && tmdbId !== lastTmdbId) {
                    console.log('[Lampa Sync] History.replaceState - new movie detected:', tmdbId);
                    lastTmdbId = tmdbId;
                    handleStart();
                }
            }, 300);
        };
        
        // Также отслеживаем popstate (навигация назад/вперёд)
        window.addEventListener('popstate', function() {
            setTimeout(() => {
                const tmdbId = getTmdbIdFromUrl();
                if (tmdbId && tmdbId !== lastTmdbId) {
                    console.log('[Lampa Sync] PopState - new movie detected:', tmdbId);
                    lastTmdbId = tmdbId;
                    handleStart();
                }
            }, 300);
        });

        // Периодическая синхронизация прогресса с сервера (каждые 15 секунд)
        // Это позволяет обновлять прогресс на втором устройстве без перезагрузки
        setInterval(async () => {
            const urlTmdbId = getTmdbIdFromUrl();
            
            // Если открыта карточка фильма (есть TMDB ID в URL)
            if (urlTmdbId) {
                try {
                    // Загружаем прогресс с сервера
                    const data = await loadProgress(urlTmdbId);
                    
                    if (data && data.time !== undefined && data.percent !== undefined) {
                        const fileId = getCurrentFileId();
                        
                        if (fileId) {
                            const fileView = getStorage('file_view', {});
                            const currentProgress = fileView[fileId];
                            
                            // Если прогресс с сервера новее (больше времени), обновляем
                            if (currentProgress && data.time > currentProgress.time) {
                                const config = getConfig();
                                if (data.time >= config.MIN_SEEK_TIME) {
                                    fileView[fileId].time = data.time;
                                    fileView[fileId].percent = data.percent;
                                    setStorage('file_view', fileView);
                                    
                                    // Обновляем UI
                                    updateUIAfterProgressChange(fileId, urlTmdbId);
                                    
                                    console.log('[Lampa Sync] 🔄 Progress synced from server:', {
                                        tmdb: urlTmdbId,
                                        fileId: fileId,
                                        time: data.time,
                                        percent: data.percent
                                    });
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Игнорируем ошибки при периодической синхронизации
                    // (чтобы не засорять консоль, если сервер недоступен)
                }
            }
        }, 15000); // Каждые 15 секунд
        
        // Периодическое автосохранение (каждые 30 секунд во время просмотра)
        setInterval(() => {
            if (currentTmdbId && currentFileId) {
                const config = getConfig();
                const fileView = getStorage('file_view', {});
                if (fileView[currentFileId]) {
                    let currentProgress = fileView[currentFileId].time || 0;
                    
                    // Получаем актуальное время из video элемента (только для встроенного плеера)
                    const usingExternalPlayer = isExternalPlayer();
                    if (!usingExternalPlayer) {
                        const playbackTime = getCurrentPlaybackTime();
                        
                        // Если получили время из video, используем его
                        if (playbackTime !== null && playbackTime > currentProgress) {
                            currentProgress = playbackTime;
                            // Обновляем file_view
                            fileView[currentFileId].time = currentProgress;
                            if (fileView[currentFileId].duration && fileView[currentFileId].duration > 0) {
                                fileView[currentFileId].percent = Math.round((currentProgress / fileView[currentFileId].duration) * 100);
                            }
                            setStorage('file_view', fileView);
                        }
                    } else {
                        // Для внешних плееров используем время из file_view
                        // Lampa обновляет его при возврате из внешнего плеера
                    }
                    
                    // Сохраняем только если есть активный просмотр
                    const progress = fileView[currentFileId];
                    if (progress && currentProgress > config.MIN_SEEK_TIME) {
                        // Сохраняем только если прошло более 30 секунд с последнего сохранения
                        // И время изменилось с момента последнего сохранения
                        const timeSinceLastSave = Date.now() - lastSavedTime;
                        const lastSavedProgress = lastFileViewTime[currentFileId] || 0;
                        
                        if (timeSinceLastSave > 30000 && currentProgress !== lastSavedProgress) {
                            console.log('[Lampa Sync] Periodic auto-save:', {
                                tmdb: currentTmdbId,
                                fileId: currentFileId,
                                time: currentProgress,
                                percent: progress.percent
                            });
                            saveProgress(currentTmdbId, currentFileId).catch(e => {
                                console.error('[Lampa Sync] Periodic auto-save error:', e);
                            });
                            lastSavedTime = Date.now();
                            lastFileViewTime[currentFileId] = currentProgress;
                        }
                    }
                }
            }
        }, 30000); // Каждые 30 секунд

        // Обновляем currentFileId периодически (на случай если он появился позже)
        setInterval(() => {
            // Проверяем изменение TMDB ID в URL (для синхронизации без перезагрузки)
            const urlTmdbId = getTmdbIdFromUrl();
            if (urlTmdbId && urlTmdbId !== lastTmdbId) {
                console.log('[Lampa Sync] TMDB ID changed in periodic check:', lastTmdbId, '->', urlTmdbId);
                lastTmdbId = urlTmdbId;
                handleStart();
            }
            
            // Если есть pending progress и появился file_id, применяем его
            if (pendingProgress && !currentFileId) {
                const fileId = getCurrentFileId();
                if (fileId) {
                    const config = getConfig();
                    const fileView = getStorage('file_view', {});
                    
                    if (fileView[fileId] && pendingProgress.time >= config.MIN_SEEK_TIME) {
                        fileView[fileId].time = pendingProgress.time;
                        fileView[fileId].percent = pendingProgress.percent;
                        setStorage('file_view', fileView);
                        console.log('[Lampa Sync] Applied pending progress to file_view[' + fileId + ']:', pendingProgress);
                        pendingProgress = null;
                        currentFileId = fileId;
                    }
                }
            }
            
            if (currentTmdbId && !currentFileId) {
                const fileId = getCurrentFileId();
                if (fileId) {
                    currentFileId = fileId;
                    console.log('[Lampa Sync] file_id found:', fileId);
                    
                    // Если есть pending progress, применяем его
                    if (pendingProgress && pendingProgress.tmdbId === currentTmdbId) {
                        const config = getConfig();
                        const fileView = getStorage('file_view', {});
                        if (fileView[fileId] && pendingProgress.time >= config.MIN_SEEK_TIME) {
                            fileView[fileId].time = pendingProgress.time;
                            fileView[fileId].percent = pendingProgress.percent;
                            setStorage('file_view', fileView);
                            console.log('[Lampa Sync] Applied pending progress to file_view[' + fileId + ']:', pendingProgress);
                            pendingProgress = null;
                        }
                    } else {
                        // Загружаем прогресс, если ещё не загружали
                        loadProgress(currentTmdbId).catch(e => {
                            console.error('[Lampa Sync] Delayed load error:', e);
                        });
                    }
                }
            }
        }, 2000);
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
     * Инициализация настроек - добавление шаблона и полей
     */
    function initSettingsTemplate() {
        try {
            if (!window.Lampa || !window.Lampa.Template) {
                console.log('[Lampa Sync] Lampa.Template not available yet');
                return false;
            }
            
            const template = `
                <div>
                    <div class="settings-param selector" data-name="lampa_sync_server_url" data-type="input" placeholder="http://localhost:3000">
                        <div class="settings-param__name">URL сервера синхронизации</div>
                        <div class="settings-param__value"></div>
                    </div>
                    <div class="settings-param selector" data-name="lampa_sync_password" data-type="input" data-string="true" placeholder="Введите пароль">
                        <div class="settings-param__name">Пароль синхронизации</div>
                        <div class="settings-param__value"></div>
                    </div>
                </div>
            `;
            
            // Добавляем шаблон
            Lampa.Template.add('settings_lampa_sync', template);
            console.log('[Lampa Sync] ✅ Settings template added');
            
            // Слушаем открытие настроек
            if (Lampa.Settings && Lampa.Settings.listener) {
                Lampa.Settings.listener.follow('open', function(e) {
                    if (e.name == 'lampa_sync') {
                        // Настройки открыты
                        console.log('[Lampa Sync] Settings opened');
                        
                        // Lampa автоматически обрабатывает поля с data-type="input"
                        // Значения сохраняются через Lampa.Storage автоматически
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
                                "
                                placeholder="http://localhost:3000"
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
                                "
                                placeholder="Введите пароль"
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
            
            // Удаляем старое модальное окно, если есть
            const oldModal = document.querySelector('.lampasync-settings-modal');
            if (oldModal) {
                oldModal.remove();
            }
            
            // Добавляем модальное окно
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            const modal = document.querySelector('.lampasync-settings-modal');
            const saveBtn = document.getElementById('lampasync-save');
            const cancelBtn = document.getElementById('lampasync-cancel');
            const urlInput = document.getElementById('lampasync-server-url');
            const passwordInput = document.getElementById('lampasync-password');
            
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
                
                // Сохраняем настройки
                if (window.Lampa && window.Lampa.Storage) {
                    Lampa.Storage.set('lampa_sync_server_url', serverUrl);
                    Lampa.Storage.set('lampa_sync_password', password);
                } else {
                    localStorage.setItem('lampa_sync_server_url', serverUrl);
                    localStorage.setItem('lampa_sync_password', password);
                }
                
                console.log('[Lampa Sync] ✅ Settings saved:', { serverUrl, password: '***' });
                alert('✅ Настройки сохранены! Плагин будет использовать новые настройки.');
                
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
    
    // Функция для добавления настроек через Lampa.SettingsApi
    function addSettings() {
        try {
            if (!window.Lampa) {
                console.log('[Lampa Sync] Lampa object not available');
                return false;
            }
            
            if (!window.Lampa.SettingsApi) {
                console.log('[Lampa Sync] Lampa.SettingsApi not available');
                // Если SettingsApi недоступен, используем модальное окно
                console.log('[Lampa Sync] 💡 Use window.LampaSync.showSettings() to open settings');
                return false;
            }
            
            // Пробуем разные варианты API
            const apiMethods = ['addParam', 'add', 'register', 'create'];
            let methodFound = null;
            
            for (const method of apiMethods) {
                if (typeof Lampa.SettingsApi[method] === 'function') {
                    methodFound = method;
                    break;
                }
            }
            
            if (!methodFound) {
                console.log('[Lampa Sync] No suitable SettingsApi method found');
                console.log('[Lampa Sync] Available methods:', Object.keys(Lampa.SettingsApi || {}));
                return false;
            }
            
            // Пробуем разные варианты типов
            const textTypes = ['text', 'string', 'input', 'url', 'password'];
            let successCount = 0;
            
            // Пробуем добавить URL сервера
            for (let textType of textTypes) {
                try {
                    const param = {
                        component: 'interface',
                        param: {
                            name: 'lampa_sync_server_url',
                            type: textType,
                            default: 'http://localhost:3000',
                        },
                        field: {
                            name: 'URL сервера синхронизации',
                            description: 'Адрес сервера для синхронизации прогресса',
                        }
                    };
                    
                    Lampa.SettingsApi[methodFound](param);
                    console.log('[Lampa Sync] ✅ URL setting added with type:', textType);
                    successCount++;
                    break;
                } catch (e) {
                    continue;
                }
            }
            
            // Пробуем добавить пароль
            for (let textType of textTypes) {
                try {
                    const param = {
                        component: 'interface',
                        param: {
                            name: 'lampa_sync_password',
                            type: textType === 'password' ? 'password' : textType,
                            default: '',
                        },
                        field: {
                            name: 'Пароль синхронизации',
                            description: 'Пароль для авторизации на сервере',
                        }
                    };
                    
                    Lampa.SettingsApi[methodFound](param);
                    console.log('[Lampa Sync] ✅ Password setting added with type:', textType);
                    successCount++;
                    break;
                } catch (e) {
                    continue;
                }
            }
            
            if (successCount === 2) {
                console.log('[Lampa Sync] ✅ Settings successfully added to Lampa interface');
                console.log('[Lampa Sync] 💡 Go to: Настройки → Интерфейс');
                return true;
            } else if (successCount === 1) {
                console.warn('[Lampa Sync] ⚠️ Only one setting was added');
                return true;
            } else {
                console.warn('[Lampa Sync] ⚠️ Failed to add settings via SettingsApi');
                console.log('[Lampa Sync] 💡 Use window.LampaSync.showSettings() to open settings modal');
                return false;
            }
        } catch (e) {
            console.error('[Lampa Sync] Error adding settings:', e);
            console.log('[Lampa Sync] 💡 Use window.LampaSync.showSettings() to open settings modal');
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
                console.warn('[Lampa Sync] 💡 Используйте один из способов настройки:');
                console.warn('');
                console.warn('  Способ 1 (рекомендуется):');
                console.warn('    window.LampaSync.showSettings()');
                console.warn('');
                console.warn('  Способ 2 (через консоль):');
                console.warn('    localStorage.setItem("lampa_sync_server_url", "http://localhost:3000");');
                console.warn('    localStorage.setItem("lampa_sync_password", "yourpassword");');
                console.warn('    location.reload();');
                console.warn('');
                console.warn('  Проверка текущих настроек:');
                console.warn('    window.LampaSync.getConfig()');
            }
        }
    }
    
    // Инициализация настроек по образцу другого плагина
    function initSettingsNew() {
        // Добавляем шаблон настроек
        if (window.Lampa && window.Lampa.Template) {
            initSettingsTemplate();
        } else {
            // Ждём загрузки Lampa
            const checkTemplate = setInterval(() => {
                if (window.Lampa && window.Lampa.Template) {
                    clearInterval(checkTemplate);
                    initSettingsTemplate();
                }
            }, 500);
            
            setTimeout(() => clearInterval(checkTemplate), 10000);
        }
        
        // Добавляем пункт меню в настройки
        function tryAddMenu() {
            if (window.Lampa && window.Lampa.Settings && window.Lampa.Settings.main) {
                if (addSettingsMenu()) {
                    console.log('[Lampa Sync] ✅ Settings menu added successfully');
                } else {
                    // Пробуем ещё раз через некоторое время
                    setTimeout(tryAddMenu, 1000);
                }
            } else {
                // Ждём появления Settings
                setTimeout(tryAddMenu, 500);
            }
        }
        
        // Ждём готовности Lampa
        if (window.appready) {
            setTimeout(tryAddMenu, 500);
        } else {
            if (window.Lampa && window.Lampa.Listener) {
                Lampa.Listener.follow('app', function(e) {
                    if (e.type == 'ready') {
                        setTimeout(tryAddMenu, 500);
                    }
                });
            } else {
                // Пробуем через интервал
                const checkListener = setInterval(() => {
                    if (window.Lampa && window.Lampa.Listener) {
                        clearInterval(checkListener);
                        Lampa.Listener.follow('app', function(e) {
                            if (e.type == 'ready') {
                                setTimeout(tryAddMenu, 500);
                            }
                        });
                    }
                }, 500);
                
                setTimeout(() => clearInterval(checkListener), 10000);
            }
        }
    }
    
    // Запускаем инициализацию настроек
    initSettingsNew();

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
        getConfig,
        showSettings: showSettingsModal
    };
    
    // Показываем инструкцию и модальное окно при загрузке, если настройки не заданы
    setTimeout(() => {
        const config = getConfig();
        const needsSetup = !config.SYNC_PASSWORD || config.SYNC_SERVER_URL === 'http://localhost:3000';
        
        if (needsSetup) {
            console.log('');
            console.log('═══════════════════════════════════════════════════════════');
            console.log('  🔧 LAMPA SYNC - ТРЕБУЕТСЯ НАСТРОЙКА');
            console.log('═══════════════════════════════════════════════════════════');
            console.log('');
            console.log('  Для настройки плагина выполните в консоли:');
            console.log('    window.LampaSync.showSettings()');
            console.log('');
            console.log('  Или настройте вручную через localStorage:');
            console.log('    localStorage.setItem("lampa_sync_server_url", "http://localhost:3000");');
            console.log('    localStorage.setItem("lampa_sync_password", "ваш_пароль");');
            console.log('');
            console.log('  Текущие настройки:');
            console.log('    URL:', config.SYNC_SERVER_URL);
            console.log('    Пароль:', config.SYNC_PASSWORD ? '***' : 'не задан');
            console.log('');
            console.log('═══════════════════════════════════════════════════════════');
            console.log('');
            
            // Автоматически открываем модальное окно через 3 секунды после загрузки
            // (даём время пользователю увидеть консоль)
            setTimeout(() => {
                // Проверяем, не настроено ли уже
                const currentConfig = getConfig();
                if (!currentConfig.SYNC_PASSWORD || currentConfig.SYNC_SERVER_URL === 'http://localhost:3000') {
                    console.log('[Lampa Sync] 💡 Открываю окно настроек...');
                    showSettingsModal();
                }
            }, 3000);
        }
    }, 2000);

})();
