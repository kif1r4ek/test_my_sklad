README: Структура сайта (React + Vite)

Почему файлов много
React‑проект состоит из исходников и сборки. Исходники ты редактируешь, а сборка — это готовые файлы, которые отдаются в интернет.

1) Что редактировать
- C:\sites\test_my_sklad\src\App.jsx  — основная логика и состояние
- C:\sites\test_my_sklad\src\views\LoginView.jsx — экран входа
- C:\sites\test_my_sklad\src\views\SuperAdminView.jsx — интерфейс супер‑админа
- C:\sites\test_my_sklad\src\views\EmployeeView.jsx — интерфейс сотрудника
- C:\sites\test_my_sklad\src\App.css  — стили для App
- C:\sites\test_my_sklad\src\index.css — глобальные стили
- C:\sites\test_my_sklad\src\main.jsx — точка входа React (обычно не трогают)

2) Что видит браузер
Папка сборки: C:\sites\test_my_sklad\dist
Она создаётся командой:
  npm run build
Внутри dist уже готовый index.html и файлы assets/*.js, assets/*.css

3) Важные служебные файлы
- package.json        — список библиотек и команд (npm run build)
- package-lock.json   — фиксация версий библиотек
- node_modules\       — все библиотеки (много файлов, не редактировать)
- vite.config.js      — настройки сборки (base: '/test_my_sklad/')
- server\             — серверные модули (config/utils/services)
- var\                — кэш карточек WB (cards-cache*.json)

4) Запуск сервера
API + статические файлы:
  npm start
Только статика (без API):
  npm run start:static

Как обновлять сайт после правок
1) Внеси изменения в src/*
2) Выполни:
   cd C:\sites\test_my_sklad
   npm run build

После этого изменения сразу появятся на https://grasklad.ru/test_my_sklad/
