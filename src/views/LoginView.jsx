export default function LoginView({
  loginSurname,
  setLoginSurname,
  loginPassword,
  setLoginPassword,
  loginError,
  loginBusy,
  handleLogin,
}) {
  return (
    <div className="app">
      <div className="login-card">
        <div className="login-title">Вход</div>
        <div className="login-subtitle">Введите фамилию и пароль</div>
        <div className="form-grid">
          <label className="field">
            <span>Фамилия (логин)</span>
            <input
              className="input"
              value={loginSurname}
              onChange={(e) => setLoginSurname(e.target.value)}
              placeholder="Иванов"
            />
          </label>
          <label className="field">
            <span>Пароль</span>
            <input
              className="input"
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="••••••"
            />
          </label>
        </div>
        {loginError && <div className="alert">{loginError}</div>}
        <div className="login-actions">
          <button className="primary-button" type="button" onClick={handleLogin} disabled={loginBusy}>
            {loginBusy ? "Вход…" : "Войти"}
          </button>
        </div>
      </div>
    </div>
  );
}
