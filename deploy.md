# Инструкция по развертыванию проекта "Грасклад"

Пошаговая инструкция для развертывания веб-приложения управления складом с интеграцией Wildberries на сервере Ubuntu 24.04 с FASTPANEL.

## Описание проекта

**Грасклад** — веб-приложение для управления складом с интеграцией Wildberries API.

### Основные возможности:

- **Управление поставками**: создание, просмотр, синхронизация поставок Wildberries
- **Управление заказами**: просмотр новых заказов, добавление в поставки
- **Сканирование товаров**: сканирование штрихкодов товаров и этикеток для сборки заказов
- **Генерация этикеток**: массовая загрузка и объединение этикеток в PDF файлы
- **Ролевая модель**: супер-админ, админ, сотрудник
- **Разделение доступа**: назначение сотрудников на поставки, разделение заказов между сотрудниками
- **Интеграция с МойСклад**: автоматическое получение информации о товарах и штрихкодах

### Технологический стек:

- **Frontend**: React 19 + Vite
- **Backend**: Node.js (Express)
- **База данных**: PostgreSQL
- **Хранилище файлов**: S3-совместимое хранилище (для PDF этикеток)
- **Интеграции**:
  - Wildberries Marketplace API
  - Wildberries Content API
  - МойСклад API

## Требования

- Ubuntu 24.04
- Node.js 18.x или выше
- PostgreSQL 12+ (доступ к БД)
- Доступ к S3-совместимому хранилищу
- API токены:
  - Wildberries API токен(ы)
  - МойСклад API токен
  - S3 ключи доступа

## Данные сервера

```
Публичный IP:      185.152.93.237
IPv6:              2a03:6f00:a::1:f74b
Приватный IP:      192.168.0.19

SSH:               ssh root@185.152.93.237
Root-пароль:       fRcZkU@WC6M-73

FASTPANEL:
URL:               http://185.152.93.237:8888
Логин:             fastuser
Пароль:            IYNACKU15sKD94Kp

Закрытые порты:    25, 587, 53413, 2525, 389, 465, 3389
```

---

## Шаг 1: Подключение к серверу

### Через SSH:

```bash
ssh root@185.152.93.237
# Пароль: fRcZkU@WC6M-73
```

### Через FASTPANEL:

1. Откройте браузер: `http://185.152.93.237:8888`
2. Войдите:
   - Логин: `fastuser`
   - Пароль: `IYNACKU15sKD94Kp`

---

## Шаг 2: Проверка и установка Node.js

Проверьте текущую версию Node.js:

```bash
node --version
# Ожидается: v18.19.1 или выше

npm --version
# Ожидается: 10.x или выше
```

Если Node.js не установлен или версия ниже 18.x:

```bash
# Установка Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt-get install -y nodejs

# Проверка установки
node --version
npm --version
```

---

## Шаг 3: Копирование проекта на сервер

### Вариант A: Через SCP (с локальной машины)

```bash
# Архивируйте проект локально (исключая node_modules, dist, var)
cd /mnt/d/Projects/test_my_sklad
tar -czf test_my_sklad.tar.gz --exclude='node_modules' --exclude='dist' --exclude='var' --exclude='.git' .

# Копируйте на сервер
scp test_my_sklad.tar.gz root@185.152.93.237:/opt/
# Пароль: fRcZkU@WC6M-73

# На сервере распакуйте
ssh root@185.152.93.237
cd /opt
mkdir -p test_my_sklad
tar -xzf test_my_sklad.tar.gz -C test_my_sklad/
rm test_my_sklad.tar.gz
```

### Вариант B: Через SFTP/FASTPANEL

1. Загрузите архив через файловый менеджер FASTPANEL
2. Распакуйте в `/opt/test_my_sklad`

### Вариант C: Через Git (рекомендуется)

```bash
cd /opt
git clone <URL_вашего_репозитория> test_my_sklad
cd test_my_sklad
```

---

## Шаг 4: Установка зависимостей

```bash
cd /opt/test_my_sklad
npm install

# Убедитесь, что установились все зависимости
npm list --depth=0
```

---

## Шаг 5: Настройка конфигурации (.env)

Создайте/отредактируйте файл `.env`:

```bash
cd /opt/test_my_sklad
nano .env
```

### Содержимое файла .env:

```bash
# ==============================================
# WILDBERRIES API TOKENS
# ==============================================
# Основной токен Wildberries (обязательно)
WB_API_TOKEN=ваш_токен_wildberries_1

# Второй токен Wildberries (опционально, если работаете с несколькими магазинами)
WB_API_TOKEN_2=

# Названия магазинов
WB_STORE_1_NAME=ИП Ирина
WB_STORE_2_NAME=ИП Евгений

# ID магазинов (по умолчанию)
WB_STORE_1_ID=irina
WB_STORE_2_ID=evgeny

# Client Secret для Wildberries (если требуется)
WB_CLIENT_SECRET=


# ==============================================
# СЕРВЕР И САЙТ
# ==============================================
# Порт для Node.js сервера
PORT=3001

# IP адрес для привязки сервера
HOST=0.0.0.0

# Корневой путь сайта (для URL: http://domain.com/ROOT_SITE/)
ROOT_SITE=test_my_sklad

# Сайт по умолчанию (если зашли на корень сервера)
DEFAULT_SITE=test_my_sklad

# Безопасные cookies (0 - для HTTP, 1 - для HTTPS через Nginx)
# ВАЖНО: Для тестирования по HTTP установите 0, для продакшена с HTTPS - 1
COOKIE_SECURE=0


# ==============================================
# БАЗА ДАННЫХ POSTGRESQL
# ==============================================
DB_HOST=212.193.30.22
DB_PORT=5432
DB_NAME=default_db
DB_USER=gen_user
DB_PASSWORD=ваш_пароль_БД

# SSL для подключения к БД (auto/require/disable)
DB_SSL=auto


# ==============================================
# S3 ХРАНИЛИЩЕ (для PDF этикеток)
# ==============================================
S3_ENDPOINT=https://s3.twcstorage.ru
S3_BUCKET=postav
S3_REGION=ru-1
S3_ACCESS_KEY=ваш_S3_access_key
S3_SECRET_KEY=ваш_S3_secret_key

# Публичный базовый URL для доступа к файлам
S3_PUBLIC_BASE=https://s3.twcstorage.ru/postav

# Использовать path-style URLs (для совместимости)
S3_FORCE_PATH_STYLE=1


# ==============================================
# МОЙСКЛАД API
# ==============================================
MS_TOKEN=ваш_моисклад_токен

# Базовый URL МойСклад API
MS_BASE_URL=https://api.moysklad.ru/api/remap/1.2

# Время кэширования данных МойСклад (в миллисекундах)
MS_CACHE_MS=600000


# ==============================================
# НАСТРОЙКИ ЭТИКЕТОК
# ==============================================
# Формат этикеток (png/pdf)
LABEL_TYPE=png

# Размеры этикеток
LABEL_WIDTH=58
LABEL_HEIGHT=40

# Количество этикеток в одном пакете (фиксированное значение)
LABEL_BATCH_SIZE=100


# ==============================================
# НАСТРОЙКИ ЗАКАЗОВ И ПОСТАВОК
# ==============================================
# Максимальное количество заказов при создании поставки (0 = без ограничений)
MAX_CREATE_COUNT=0

# Размер батча для добавления заказов в поставку
ORDER_BATCH_SIZE=100

# Включить автоматическое заполнение названий товаров (0/1)
NAME_BACKFILL_ENABLED=1

# Размер батча для заполнения названий
NAME_BACKFILL_BATCH=30

# Интервал между запусками заполнения названий (мс)
NAME_BACKFILL_INTERVAL_MS=600000

# Задержка перед первым запуском заполнения названий (мс)
NAME_BACKFILL_DELAY_MS=8000


# ==============================================
# НАСТРОЙКИ КЭШИРОВАНИЯ
# ==============================================
# Время кэширования информации о товарах (мс)
PRODUCT_CACHE_MS=21600000

# Время кэширования отсутствующих товаров (мс)
PRODUCT_NEGATIVE_CACHE_MS=900000

# Размер батча для разрешения информации о товарах
PRODUCT_RESOLVE_BATCH=30

# Время кэширования списка поставок (мс)
CACHE_SUPPLIES_MS=5000

# Время кэширования заказов (мс)
CACHE_ORDERS_MS=12000

# Время кэширования новых заказов (мс)
CACHE_NEW_ORDERS_MS=15000

# Интервал синхронизации поставок (мс)
SUPPLY_SYNC_MS=60000


# ==============================================
# ДИРЕКТОРИИ
# ==============================================
# Директория для кэша (по умолчанию: ./var)
CACHE_DIR=./var

# Путь к файлу кэша карточек товаров
CARDS_CACHE_FILE=./var/cards-cache.json
```

### Важные параметры для настройки:

1. **WB_API_TOKEN** - обязательно укажите ваш токен Wildberries
2. **DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD** - данные вашей PostgreSQL базы
3. **S3_ACCESS_KEY, S3_SECRET_KEY** - ключи доступа к S3 хранилищу
4. **MS_TOKEN** - токен МойСклад API
5. **PORT** - порт, на котором будет работать сервер (по умолчанию 3001)
6. **HOST** - установите `0.0.0.0` для доступа извне
7. **ROOT_SITE** - путь сайта (например, `test_my_sklad` для URL: `http://domain.com/test_my_sklad/`)

Сохраните файл: `Ctrl+X`, затем `Y`, затем `Enter`.

---

## Шаг 6: Сборка frontend

Соберите React приложение:

```bash
cd /opt/test_my_sklad
npm run build

# Проверьте, что создалась папка dist
ls -la dist/
```

Вывод должен показать собранные файлы `index.html` и папку `assets/`.

---

## Шаг 7: Тестовый запуск

> **ВАЖНО**: Перед запуском убедитесь, что порт 3001 не занят другим процессом. Если порт занят, выполните:
>
> ```bash
> # Найдите процесс, использующий порт 3001
> lsof -ti:3001
>
> # Убейте процесс (замените PID на полученный выше)
> kill -9 PID
> ```

Выполните тестовый запуск сервера:

```bash
cd /opt/test_my_sklad
npm start
```

### Ожидаемый вывод:

```
Multi-site server running on http://0.0.0.0:3001
```

Откройте браузер и перейдите по адресу:

```
http://185.152.93.237:3001/test_my_sklad/
```

Если всё работает корректно, вы должны увидеть страницу входа.

## Шаг 8: Настройка systemd для автозапуска

Создайте systemd service для автоматического запуска приложения при старте сервера.

### Создайте systemd service файл:

```bash
nano /etc/systemd/system/test_my_sklad.service
```

### Содержимое файла:

```ini
[Unit]
Description=Test My Sklad - Warehouse Management System
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/test_my_sklad
ExecStart=/usr/bin/node /opt/test_my_sklad/server.mjs
Restart=always
RestartSec=10
StandardOutput=append:/var/log/test_my_sklad/output.log
StandardError=append:/var/log/test_my_sklad/error.log

Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Сохраните: `Ctrl+X`, затем `Y`, затем `Enter`.

### Создайте директорию для логов:

```bash
mkdir -p /var/log/test_my_sklad
chmod 755 /var/log/test_my_sklad
```

### Включите и запустите сервис:

```bash
# Перезагрузите конфигурацию systemd
systemctl daemon-reload

# Включите автозапуск
systemctl enable test_my_sklad

# Запустите сервис
systemctl start test_my_sklad

# Проверьте статус
systemctl status test_my_sklad
```

### Полезные команды для управления сервисом:

```bash
# Перезапустить приложение
systemctl restart test_my_sklad

# Остановить приложение
systemctl stop test_my_sklad

# Запустить приложение
systemctl start test_my_sklad

# Просмотр логов в реальном времени
journalctl -u test_my_sklad -f

# Просмотр последних 100 строк логов
journalctl -u test_my_sklad -n 100
```

---

## Шаг 9: Настройка Nginx (опционально, но рекомендуется)

Nginx будет использоваться как reverse proxy для Node.js приложения и для работы по HTTPS.

### Установка Nginx:

```bash
apt-get update
apt-get install -y nginx
```

### Создайте конфигурацию Nginx для сайта:

```bash
nano /etc/nginx/sites-available/test_my_sklad
```

### Содержимое конфигурации:

```nginx
server {
    listen 80;
    listen [::]:80;

    server_name 185.152.93.237 test_my_sklad.yourdomain.com;

    # Логи
    access_log /var/log/nginx/test_my_sklad_access.log;
    error_log /var/log/nginx/test_my_sklad_error.log;

    # Максимальный размер загружаемых файлов
    client_max_body_size 50M;

    # Прокси для Node.js приложения
    location /test_my_sklad/ {
        proxy_pass http://127.0.0.1:3001/test_my_sklad/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Таймауты
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Редирект корня на приложение (опционально)
    location = / {
        return 302 /test_my_sklad/;
    }

    # Health check эндпоинт
    location /health {
        proxy_pass http://127.0.0.1:3001/health;
        access_log off;
    }
}
```

### Активируйте конфигурацию:

```bash
# Создайте символическую ссылку
ln -s /etc/nginx/sites-available/test_my_sklad /etc/nginx/sites-enabled/

# Проверьте конфигурацию на ошибки
nginx -t

# Перезапустите Nginx
systemctl restart nginx

# Включите автозапуск Nginx
systemctl enable nginx
```

### Теперь приложение доступно через Nginx:

```
http://185.152.93.237/test_my_sklad/
```

### Настройка HTTPS с Let's Encrypt (рекомендуется):

```bash
# Установите Certbot
apt-get install -y certbot python3-certbot-nginx

# Получите SSL сертификат (замените yourdomain.com на ваш домен)
certbot --nginx -d test_my_sklad.yourdomain.com

# Следуйте инструкциям Certbot

# Проверьте автообновление сертификата
certbot renew --dry-run
```

После этого сайт будет доступен по HTTPS:

```
https://test_my_sklad.yourdomain.com/test_my_sklad/
```

---

## Шаг 10: Настройка файрвола (UFW)

Настройте файрвол для защиты сервера:

```bash
# Проверьте статус UFW
ufw status

# Разрешите SSH (ВАЖНО! Сделайте это перед включением UFW)
ufw allow 22/tcp

# Разрешите HTTP и HTTPS
ufw allow 80/tcp
ufw allow 443/tcp

# Разрешите порт FASTPANEL
ufw allow 8888/tcp

# Включите UFW
ufw enable

# Проверьте правила
ufw status verbose
```

---

## Шаг 11: Проверка работы приложения

### 1. Проверьте статус сервиса:

```bash
systemctl status test_my_sklad

# Просмотр логов
journalctl -u test_my_sklad -n 50
```

### 2. Проверьте статус Nginx:

```bash
systemctl status nginx
```

### 3. Проверьте health check:

```bash
curl http://127.0.0.1:3001/health
# Ожидается: {"ok":true}
```

### 4. Откройте приложение в браузере:

```
http://185.152.93.237/test_my_sklad/
или
https://yourdomain.com/test_my_sklad/
```

### 5. Войдите в систему:

- **Фамилия**: `Администратор`
- **Имя**: `Супер`
- **Пароль**: `admin123`

### 6. Создайте дополнительных пользователей:

После входа как супер-админ:

1. Перейдите в раздел "Пользователи"
2. Создайте админа и сотрудников
3. **Обязательно** смените пароль супер-админа!

---

## Шаг 12: Настройка резервного копирования БД

Создайте скрипт для автоматического резервного копирования PostgreSQL:

```bash
mkdir -p /opt/backups
nano /opt/backups/backup-db.sh
```

### Содержимое скрипта:

```bash
#!/bin/bash

# Конфигурация
DB_HOST="212.193.30.22"
DB_PORT="5432"
DB_NAME="default_db"
DB_USER="gen_user"
DB_PASSWORD="ваш_пароль_БД"
BACKUP_DIR="/opt/backups/test_my_sklad"
RETENTION_DAYS=7

# Создаём директорию для бэкапов
mkdir -p "$BACKUP_DIR"

# Имя файла бэкапа с датой
BACKUP_FILE="$BACKUP_DIR/test_my_sklad_$(date +%Y%m%d_%H%M%S).sql.gz"

# Экспорт пароля для pg_dump
export PGPASSWORD="$DB_PASSWORD"

# Создаём бэкап
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" | gzip > "$BACKUP_FILE"

# Проверка успешности
if [ $? -eq 0 ]; then
    echo "$(date): Backup created successfully: $BACKUP_FILE" >> "$BACKUP_DIR/backup.log"
else
    echo "$(date): Backup failed!" >> "$BACKUP_DIR/backup.log"
    exit 1
fi

# Удаляем старые бэкапы (старше RETENTION_DAYS дней)
find "$BACKUP_DIR" -name "test_my_sklad_*.sql.gz" -mtime +$RETENTION_DAYS -delete

# Очистка переменной пароля
unset PGPASSWORD

echo "$(date): Old backups cleaned up" >> "$BACKUP_DIR/backup.log"
```

### Сделайте скрипт исполняемым:

```bash
chmod +x /opt/backups/backup-db.sh
```

### Настройте автоматическое выполнение через cron:

```bash
crontab -e
```

Добавьте строку для ежедневного бэкапа в 2:00 ночи:

```
0 2 * * * /opt/backups/backup-db.sh >> /opt/backups/cron.log 2>&1
```

Сохраните и выйдите.

### Проверьте работу скрипта:

```bash
/opt/backups/backup-db.sh

# Проверьте создание бэкапа
ls -lh /opt/backups/test_my_sklad/
```

---

## Структура проекта

```
test_my_sklad/
├── server/                    # Серверная часть
│   ├── config.mjs            # Конфигурация сервера
│   ├── utils.mjs             # Утилиты
│   └── services/             # Сервисы
│       ├── s3.mjs            # Работа с S3 хранилищем
│       └── ms.mjs            # Интеграция с МойСклад
├── src/                      # Frontend (React)
│   ├── App.jsx               # Основная логика приложения
│   ├── App.css               # Стили
│   ├── main.jsx              # Точка входа React
│   └── views/                # Компоненты-представления
│       ├── LoginView.jsx     # Страница входа
│       ├── SuperAdminView.jsx # Интерфейс супер-админа
│       └── EmployeeView.jsx  # Интерфейс сотрудника
├── dist/                     # Собранный frontend (создаётся при сборке)
├── var/                      # Кэш приложения
├── sql/                      # SQL скрипты
│   └── init.sql              # Инициализация БД
├── .env                      # Конфигурация окружения
├── package.json              # Зависимости Node.js
├── vite.config.js            # Настройки Vite
└── server.mjs                # Главный файл сервера
```

---

## Устранение неполадок

### Ошибка "EADDRINUSE: address already in use"

**Проблема**: `Error: listen EADDRINUSE: address already in use 0.0.0.0:3001`

**Причина**: Порт 3001 уже занят другим процессом (возможно, приложение уже запущено)

**Решение**:

```bash
# Подключитесь к серверу
ssh root@185.152.93.237
# Пароль: fRcZkU@WC6M-73

# Найдите процесс, использующий порт 3001
lsof -ti:3001

# Убейте процесс (автоматически подставит PID)
kill -9 $(lsof -ti:3001)

# Или остановите systemd сервис
systemctl stop test_my_sklad

# Проверьте, что порт освободился
lsof -ti:3001
# Не должно быть вывода

# Теперь можно запустить приложение заново
cd /opt/test_my_sklad

# Для тестового запуска:
npm start

# Или через systemd (рекомендуется):
systemctl start test_my_sklad

# Проверьте статус
systemctl status test_my_sklad
journalctl -u test_my_sklad -n 50
```

### Ошибка подключения к серверу (Firefox: "Попытка соединения не удалась")

**Проблема**: Браузер не может подключиться к `http://185.152.93.237:3001`

**Возможные причины**:

1. **Сервер не запущен**:
   ```bash
   # Проверьте статус
   systemctl status test_my_sklad
   # или
   curl http://127.0.0.1:3001/health
   ```

2. **Неправильный URL**:
   - Правильный URL: `http://185.152.93.237:3001/test_my_sklad/`
   - Обратите внимание на `/test_my_sklad/` в конце!

3. **Файрвол блокирует порт 3001**:
   ```bash
   # Разрешите порт 3001 в UFW
   ufw allow 3001/tcp
   ufw reload

   # Проверьте правила
   ufw status verbose
   ```

4. **COOKIE_SECURE установлен в 1 (требует HTTPS)**:
   - Для прямого доступа по HTTP откройте `.env` и установите:
   ```bash
   COOKIE_SECURE=0
   ```
   - Затем перезапустите приложение:
   ```bash
   systemctl restart test_my_sklad
   ```
   - **Важно**: Для продакшена используйте Nginx с HTTPS и установите `COOKIE_SECURE=1`

5. **Приложение слушает только localhost**:
   - Убедитесь, что в `.env` установлено:
   ```bash
   HOST=0.0.0.0
   PORT=3001
   ```
   - Перезапустите приложение после изменений

### Ошибка подключения к БД

**Проблема**: `Error: connect ECONNREFUSED 212.193.30.22:5432`

**Решение**:
1. Проверьте доступность БД:
   ```bash
   nc -zv 212.193.30.22 5432
   ```
2. Проверьте данные в `.env` (правильность логина/пароля)
3. Убедитесь, что IP сервера добавлен в whitelist PostgreSQL
4. Проверьте правила файрвола на сервере БД

### Ошибка API Wildberries (401 Unauthorized)

**Проблема**: `Unauthorized` при запросах к Wildberries

**Решение**:
1. Проверьте токен в `.env` (`WB_API_TOKEN`)
2. Убедитесь, что токен имеет необходимые права:
   - Marketplace API (orders, supplies)
   - Content API (cards)
3. Проверьте срок действия токена

### Ошибка API Wildberries (429 Too Many Requests)

**Проблема**: `Too Many Requests`

**Решение**:
- Приложение автоматически обрабатывает rate limiting
- Проверьте логи: `journalctl -u test_my_sklad -n 100`
- Увеличьте интервалы кэширования в `.env`:
  ```bash
  CACHE_SUPPLIES_MS=10000
  CACHE_ORDERS_MS=20000
  ```

### Приложение не запускается

**Проблема**: Сервис показывает статус `failed` или `errored`

**Решение**:
1. Проверьте логи:
   ```bash
   journalctl -u test_my_sklad -n 100
   ```
2. Проверьте, что выполнена сборка frontend:
   ```bash
   ls -la /opt/test_my_sklad/dist/
   ```
3. Проверьте права доступа:
   ```bash
   chown -R root:root /opt/test_my_sklad
   chmod -R 755 /opt/test_my_sklad
   ```
4. Проверьте `.env` на наличие синтаксических ошибок

### Не работает доступ через Nginx

**Проблема**: Nginx возвращает `502 Bad Gateway`

**Решение**:
1. Проверьте, что Node.js приложение запущено:
   ```bash
   systemctl status test_my_sklad
   curl http://127.0.0.1:3001/health
   ```
2. Проверьте логи Nginx:
   ```bash
   tail -f /var/log/nginx/test_my_sklad_error.log
   ```
3. Проверьте конфигурацию Nginx:
   ```bash
   nginx -t
   ```
4. Перезапустите Nginx:
   ```bash
   systemctl restart nginx
   ```

### Не загружаются этикетки (S3 ошибка)

**Проблема**: Ошибка при загрузке PDF этикеток

**Решение**:
1. Проверьте S3 ключи в `.env`:
   ```bash
   S3_ACCESS_KEY=...
   S3_SECRET_KEY=...
   ```
2. Проверьте доступность S3:
   ```bash
   curl -I https://s3.twcstorage.ru/postav/
   ```
3. Проверьте права доступа к bucket (должен разрешать upload)
4. Проверьте логи приложения на наличие подробных ошибок S3

### Приложение медленно работает

**Проблема**: Долгая загрузка данных

**Решение**:
1. Проверьте соединение с БД (проверьте ping)
2. Добавьте индексы в БД (уже включены в `init.sql`)
3. Увеличьте время кэширования в `.env`:
   ```bash
   PRODUCT_CACHE_MS=43200000  # 12 часов
   MS_CACHE_MS=1200000        # 20 минут
   ```
4. Проверьте нагрузку на сервер:
   ```bash
   htop
   ```

---

## Полезные команды

### Управление приложением

```bash
# Перезапустить приложение
systemctl restart test_my_sklad

# Остановить приложение
systemctl stop test_my_sklad

# Запустить приложение
systemctl start test_my_sklad

# Проверить статус
systemctl status test_my_sklad

# Просмотр логов
journalctl -u test_my_sklad -n 100

# Просмотр логов в реальном времени
journalctl -u test_my_sklad -f
```

### Обновление приложения

```bash
# Остановите приложение
systemctl stop test_my_sklad

# Перейдите в директорию проекта
cd /opt/test_my_sklad

# Сделайте резервную копию (если нужно)
tar -czf /opt/backups/test_my_sklad_backup_$(date +%Y%m%d).tar.gz /opt/test_my_sklad

# Обновите код (через git или загрузите новые файлы)
git pull origin main
# или загрузите новые файлы через scp/sftp

# Установите новые зависимости (если изменился package.json)
npm install

# Пересоберите frontend
npm run build

# Запустите приложение
systemctl start test_my_sklad

# Проверьте логи
journalctl -u test_my_sklad -n 50
```

### Работа с базой данных

```bash
# Подключение к БД
psql -h 212.193.30.22 -U gen_user -d default_db

# Количество пользователей
SELECT COUNT(*) FROM users;

# Список всех пользователей
SELECT id, surname, name, role, created_at FROM users;

# Количество поставок
SELECT COUNT(*) FROM supply_settings;

# Количество заказов
SELECT COUNT(*) FROM supply_orders;

# Статистика по поставкам
SELECT
    ss.supply_id,
    ss.supply_name,
    ss.access_mode,
    COUNT(so.wb_order_id) as total_orders,
    COUNT(so.collected_at) as collected_orders
FROM supply_settings ss
LEFT JOIN supply_orders so ON ss.supply_id = so.supply_id
GROUP BY ss.supply_id, ss.supply_name, ss.access_mode
ORDER BY total_orders DESC
LIMIT 20;

# Активные сессии пользователей
SELECT
    s.token,
    u.surname,
    u.name,
    u.role,
    s.expires_at
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.expires_at > NOW()
ORDER BY s.expires_at DESC;

# Очистка старых сессий
DELETE FROM sessions WHERE expires_at < NOW();
```

### Просмотр логов

```bash
# Логи приложения
journalctl -u test_my_sklad -n 100

# Логи приложения в реальном времени
journalctl -u test_my_sklad -f

# Логи Nginx (access)
tail -f /var/log/nginx/test_my_sklad_access.log

# Логи Nginx (error)
tail -f /var/log/nginx/test_my_sklad_error.log

# Системные логи
journalctl -u nginx -f
```

### Мониторинг сервера

```bash
# Загрузка CPU и памяти
htop

# Дисковое пространство
df -h

# Использование памяти
free -h

# Активные сетевые соединения
netstat -tuln | grep LISTEN

# Проверка портов приложения
ss -tlnp | grep -E ':(3001|80|443|8888)'
```

### Очистка дискового пространства

```bash
# Очистка старых логов приложения (старше 30 дней)
journalctl --vacuum-time=30d

# Очистка старых логов Nginx (старше 30 дней)
find /var/log/nginx -name "*.log" -mtime +30 -delete

# Очистка кэша приложения
rm -rf /opt/test_my_sklad/var/*

# Очистка старых бэкапов (старше 30 дней)
find /opt/backups/test_my_sklad -name "*.sql.gz" -mtime +30 -delete
```

---

## Рекомендации по безопасности

1. **Смените пароль супер-админа** сразу после первого входа
2. **Создайте сильные пароли** для всех пользователей (минимум 12 символов)
3. **Регулярно обновляйте** Node.js и зависимости:
   ```bash
   npm audit
   npm audit fix
   npm outdated
   npm update
   ```
4. **Настройте HTTPS** с помощью Let's Encrypt
5. **Ограничьте доступ к SSH** только с доверенных IP:
   ```bash
   # В /etc/ssh/sshd_config добавьте:
   AllowUsers root@your_trusted_ip
   ```
6. **Включите автоматические обновления безопасности**:
   ```bash
   apt-get install -y unattended-upgrades
   dpkg-reconfigure -plow unattended-upgrades
   ```
7. **Регулярно делайте резервные копии** базы данных
8. **Храните .env файл в безопасности** (не коммитьте в git!)
9. **Мониторьте логи** на предмет подозрительной активности
10. **Используйте Fail2Ban** для защиты от brute-force атак:
    ```bash
    apt-get install -y fail2ban
    systemctl enable fail2ban
    systemctl start fail2ban
    ```

---

## Контакты и поддержка

При возникновении проблем:

1. Проверьте логи приложения: `journalctl -u test_my_sklad -n 100`
2. Проверьте логи Nginx: `/var/log/nginx/test_my_sklad_error.log`
3. Проверьте статус сервисов:
   ```bash
   systemctl status test_my_sklad
   systemctl status nginx
   ```
4. Проверьте подключение к БД и внешним API

---

## Changelog

### Версия 1.0.0 (2025-02-10)
- Первоначальное развертывание
- Интеграция с Wildberries API
- Интеграция с МойСклад API
- Система управления пользователями (супер-админ, админ, сотрудник)
- Управление поставками и заказами
- Сканирование товаров и этикеток
- Генерация PDF этикеток
- Загрузка этикеток в S3

---

**Успешного развертывания!**
