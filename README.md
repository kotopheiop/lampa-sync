# Lampa Sync

Плагин синхронизации прогресса просмотра, истории и закладок между устройствами в [Lampa](https://github.com/yumata/lampa).

## Установка

В Lampa: **Настройки → Расширения → Добавить плагин** и вставь URL:

```text
https://kotopheiop.github.io/lampa-sync/plugin.js
```

Либо с своего сервера: `http://<IP-сервера>:3000/plugin.js`

## Настройка

1. Подними сервер: [lampa-sync-server](https://github.com/kotopheiop/lampa-sync-server)
2. В Lampa: **Настройки → Интерфейс → Синхронизация прогресса**
   - **URL сервера** — например `http://192.168.1.10:3000`
   - **Пароль** — тот же, что `SYNC_PASSWORD` в `.env` сервера
3. Нажми **Проверить подключение** (или кнопку sync в шапке рядом с поиском)

На каждом устройстве — тот же URL и пароль.

## Что синхронизируется

- прогресс просмотра (время / процент)
- история
- закладки и связанные списки избранного

## Кнопка sync

В шапке рядом с поиском (на мобилке — рядом с уведомлениями) есть кнопка обновления: ручной полный sync без захода в настройки.

## Требования

- Lampa с поддержкой расширений
- Свой сервер синхронизации ([Docker / Go](https://github.com/kotopheiop/lampa-sync-server))

## Ссылки

| | |
|---|---|
| Плагин (GitHub Pages) | https://kotopheiop.github.io/lampa-sync/plugin.js |
| Репозиторий плагина | https://github.com/kotopheiop/lampa-sync |
| Сервер | https://github.com/kotopheiop/lampa-sync-server |
