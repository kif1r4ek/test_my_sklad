export default function SuperAdminView({
  currentUser,
  userTab,
  setUserTab,
  users,
  usersLoading,
  usersError,
  userActionError,
  userActionBusy,
  createUserSurname,
  setCreateUserSurname,
  createUserName,
  setCreateUserName,
  createUserPassword,
  setCreateUserPassword,
  handleCreateUser,
  handleLogout,
  openEditUser,
  handleDeleteUser,
  editUser,
  setEditUser,
  editSurname,
  setEditSurname,
  editName,
  setEditName,
  editPassword,
  setEditPassword,
  handleSaveUser,
  formatDate,
}) {
  const adminCount = userTab === "admins" ? users.length : 0;
  const employeeCount = userTab === "employees" ? users.length : 0;
  const usersTitle = userTab === "admins" ? "Администраторы" : "Сотрудники";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">WB Склад</div>
            <div className="subtitle">Супер админ</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <div className="user-name">{currentUser.surname} {currentUser.name}</div>
            <div className="user-role">Супер админ</div>
          </div>
          <button className="ghost-button small" type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      <div className="tabs">
        <button
          className={`tab ${userTab === "admins" ? "active" : ""}`}
          onClick={() => setUserTab("admins")}
          type="button"
        >
          Админы
          <span className="badge">{adminCount}</span>
        </button>
        <button
          className={`tab ${userTab === "employees" ? "active" : ""}`}
          onClick={() => setUserTab("employees")}
          type="button"
        >
          Сотрудники
          <span className="badge">{employeeCount}</span>
        </button>
      </div>

      <section className="card">
        <div className="section-header">
          <div className="section-title">{usersTitle}</div>
          <div className="hint">Создание и управление пользователями</div>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Фамилия (логин)</span>
            <input
              className="input"
              value={createUserSurname}
              onChange={(e) => setCreateUserSurname(e.target.value)}
              placeholder="Иванов"
            />
          </label>
          <label className="field">
            <span>Имя</span>
            <input
              className="input"
              value={createUserName}
              onChange={(e) => setCreateUserName(e.target.value)}
              placeholder="Иван"
            />
          </label>
          <label className="field">
            <span>Пароль</span>
            <input
              className="input"
              type="password"
              value={createUserPassword}
              onChange={(e) => setCreateUserPassword(e.target.value)}
              placeholder="Пароль"
            />
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <button
              className="primary-button"
              type="button"
              onClick={handleCreateUser}
              disabled={userActionBusy}
            >
              Создать
            </button>
          </div>
        </div>

        {userActionError && <div className="alert small">{userActionError}</div>}
        {usersError && <div className="alert small">{usersError}</div>}

        <div className="list users">
          <div className="list-header">
            <div className="col">Фамилия</div>
            <div className="col">Имя</div>
            <div className="col">Роль</div>
            <div className="col">Создан</div>
            <div className="col right">Действия</div>
          </div>
          <div className="list-body">
            {usersLoading ? (
              <div className="empty">Загрузка…</div>
            ) : users.length === 0 ? (
              <div className="empty">Пока нет пользователей</div>
            ) : (
              users.map((user) => (
                <div className="row" key={user.id}>
                  <div className="col">
                    <div className="primary">{user.surname}</div>
                  </div>
                  <div className="col">{user.name}</div>
                  <div className="col mono">
                    {user.role === "admin" ? "Админ" : user.role === "employee" ? "Сотрудник" : "Супер админ"}
                  </div>
                  <div className="col">{formatDate(user.createdAt)}</div>
                  <div className="col right actions">
                    <button className="ghost-button small" type="button" onClick={() => openEditUser(user)}>
                      Редактировать
                    </button>
                    <button className="ghost-button small danger" type="button" onClick={() => handleDeleteUser(user)}>
                      Удалить
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {editUser && (
        <div className="modal-backdrop" onClick={() => setEditUser(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Редактировать пользователя</div>
                <div className="modal-subtitle">{editUser.surname}</div>
              </div>
              <button className="icon-button" onClick={() => setEditUser(null)} type="button">
                {"\u00d7"}
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <label className="field">
                  <span>Фамилия (логин)</span>
                  <input
                    className="input"
                    value={editSurname}
                    onChange={(e) => setEditSurname(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Имя</span>
                  <input
                    className="input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Новый пароль</span>
                  <input
                    className="input"
                    type="password"
                    value={editPassword}
                    onChange={(e) => setEditPassword(e.target.value)}
                    placeholder="Оставьте пустым, если не менять"
                  />
                </label>
              </div>
              {userActionError && <div className="alert small">{userActionError}</div>}
              <div className="modal-actions">
                <button className="ghost-button" type="button" onClick={() => setEditUser(null)}>
                  Отмена
                </button>
                <button className="primary-button" type="button" onClick={handleSaveUser} disabled={userActionBusy}>
                  Сохранить
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
