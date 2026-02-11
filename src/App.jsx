import { useEffect, useMemo, useRef, useState } from "react";
import LoginView from "./views/LoginView.jsx";
import SuperAdminView from "./views/SuperAdminView.jsx";
import EmployeeView from "./views/EmployeeView.jsx";
import "./App.css";
const REFRESH_MS = 30000;
const REFRESH_SUPPLIES_MS = 5000;
const REFRESH_NEW_ORDERS_MS = 15000;
const REFRESH_FAST_MS = 3000;
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
const PAGE_SIZE = 50;

function timeAgo(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return "—";
  const totalMin = Math.max(0, Math.floor(diffMs / 60000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return `${hours} ч ${minutes} мин назад`;
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ru-RU");
}

function supplyAccessLabel(supply) {
  if (!supply) return "";
  const mode = supply.accessMode;
  if (mode === "all") return "Доступ: всем";
  if (mode === "hidden") return "Доступ: скрыт";
  const count = supply.accessUserCount ?? 0;
  return `Сотрудники: ${count}`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, { cache: "no-store", credentials: "include", ...options });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && (data.error || data.message)) ||
      (typeof data === "string" ? data : null) ||
      `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data ?? {};
}

function pickOrders(orders, sortDir, count) {
  const sorted = [...orders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (sortDir === "newest") sorted.reverse();
  if (!sorted.length) {
    return { selected: [], available: 0, warehouseId: null, cargoType: null };
  }
  const base = sorted[0];
  const filtered = sorted.filter((o) => {
    const sameWarehouse = base.warehouseId == null || o.warehouseId === base.warehouseId;
    const sameCargo = base.cargoType == null || o.cargoType === base.cargoType;
    return sameWarehouse && sameCargo;
  });
  return {
    selected: filtered.slice(0, count),
    available: filtered.length,
    warehouseId: base.warehouseId ?? null,
    cargoType: base.cargoType ?? null,
  };
}

function sortOrders(list, sortDir) {
  const sorted = [...list].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (sortDir === "newest") sorted.reverse();
  return sorted;
}

function matchesGroup(order, group) {
  if (group.warehouseId != null && order.warehouseId !== group.warehouseId) return false;
  if (group.cargoType != null && order.cargoType !== group.cargoType) return false;
  return true;
}

function buildArticleSelection(rows, articleMap) {
  const seen = new Set();
  const usableRows = [];
  for (const row of rows) {
    if (!row.article) continue;
    if (seen.has(row.article)) continue;
    seen.add(row.article);
    usableRows.push(row);
  }
  let group = { warehouseId: null, cargoType: null };

  for (const row of usableRows) {
    const entry = articleMap.get(row.article);
    if (!entry || entry.orders.length === 0) continue;
    const sorted = sortOrders(entry.orders, row.sortDir);
    const first = sorted[0];
    if (first) {
      group = {
        warehouseId: first.warehouseId ?? null,
        cargoType: first.cargoType ?? null,
      };
      break;
    }
  }

  const availableByArticle = new Map();
  for (const [article, entry] of articleMap.entries()) {
    const filtered = entry.orders.filter((order) => matchesGroup(order, group));
    availableByArticle.set(article, filtered.length);
  }

  const selected = [];
  for (const row of usableRows) {
    const entry = articleMap.get(row.article);
    if (!entry) continue;
    const filtered = entry.orders.filter((order) => matchesGroup(order, group));
    const sorted = sortOrders(filtered, row.sortDir);
    const countRaw = Number(row.count) || 0;
    const count = Math.max(0, Math.min(countRaw, sorted.length));
    selected.push(...sorted.slice(0, count));
  }

  const selectedIds = new Set();
  const unique = [];
  for (const order of selected) {
    const id = order.id;
    if (selectedIds.has(id)) continue;
    selectedIds.add(id);
    unique.push(order);
  }

  return {
    selected: unique,
    availableByArticle,
    warehouseId: group.warehouseId ?? null,
    cargoType: group.cargoType ?? null,
  };
}

function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [loginSurname, setLoginSurname] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [storeOptions, setStoreOptions] = useState([]);
  const [storeId, setStoreId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("wb_store_id") || "";
  });

  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [userTab, setUserTab] = useState("admins");
  const [createUserSurname, setCreateUserSurname] = useState("");
  const [createUserName, setCreateUserName] = useState("");
  const [createUserPassword, setCreateUserPassword] = useState("");
  const [userActionBusy, setUserActionBusy] = useState(false);
  const [userActionError, setUserActionError] = useState("");
  const [editUser, setEditUser] = useState(null);
  const [editSurname, setEditSurname] = useState("");
  const [editName, setEditName] = useState("");
  const [editPassword, setEditPassword] = useState("");

  const [tab, setTab] = useState("new");
  const [newOrders, setNewOrders] = useState([]);
  const [supplies, setSupplies] = useState([]);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  const [selectedSupply, setSelectedSupply] = useState(null);
  const [supplyOrders, setSupplyOrders] = useState([]);
  const [supplyLoading, setSupplyLoading] = useState(false);
  const [supplyError, setSupplyError] = useState("");
  const [supplyTab, setSupplyTab] = useState("orders");
  const [supplySettings, setSupplySettings] = useState(null);
  const [supplySettingsLoading, setSupplySettingsLoading] = useState(false);
  const [supplySettingsError, setSupplySettingsError] = useState("");
  const [supplyAccessMode, setSupplyAccessMode] = useState("hidden");
  const [supplyAccessUsers, setSupplyAccessUsers] = useState([]);
  const [supplyEmployees, setSupplyEmployees] = useState([]);
  const [supplyProgress, setSupplyProgress] = useState([]);
  const [supplyTotals, setSupplyTotals] = useState({ total: 0, collected: 0, remaining: 0 });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [labelsBusy, setLabelsBusy] = useState(false);
  const [linksItems, setLinksItems] = useState([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState("");
  const [linksUpdatedAt, setLinksUpdatedAt] = useState(null);
  const [linksMsByArticle, setLinksMsByArticle] = useState({});
  const [linksMsLoading, setLinksMsLoading] = useState(false);
  const [linksMsError, setLinksMsError] = useState("");
  const [linksProgress, setLinksProgress] = useState({ done: 0, total: 0 });

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createMode, setCreateMode] = useState("count");
  const [createCount, setCreateCount] = useState(50);
  const [createSort, setCreateSort] = useState("newest");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [createWarning, setCreateWarning] = useState("");
  const [page, setPage] = useState(1);
  const rowIdRef = useRef(1);
  const liveStateRef = useRef({
    isAdmin: false,
    isEmployee: false,
    tab: "new",
    createOpen: false,
    selectedSupply: null,
    supplyTab: "orders",
    employeeSelectedSupply: null,
    employeeSelectedItem: null,
  });
  const liveTimerRef = useRef(null);
  const [articleRows, setArticleRows] = useState(() => [
    { id: rowIdRef.current++, article: "", count: 1, sortDir: "newest" },
  ]);

  const [employeeSupplies, setEmployeeSupplies] = useState([]);
  const [employeeSuppliesLoading, setEmployeeSuppliesLoading] = useState(false);
  const [employeeSuppliesError, setEmployeeSuppliesError] = useState("");
  const [employeeSelectedSupply, setEmployeeSelectedSupply] = useState(null);
  const [employeeItems, setEmployeeItems] = useState([]);
  const [employeeItemsLoading, setEmployeeItemsLoading] = useState(false);
  const [employeeItemsError, setEmployeeItemsError] = useState("");
  const [employeeSelectedItem, setEmployeeSelectedItem] = useState(null);
  const [employeeOrders, setEmployeeOrders] = useState([]);
  const [employeeOrdersLoading, setEmployeeOrdersLoading] = useState(false);
  const [employeeOrdersError, setEmployeeOrdersError] = useState("");
  const [employeeSelectedOrder, setEmployeeSelectedOrder] = useState(null);
  const [employeeCollecting, setEmployeeCollecting] = useState(false);
  const [employeeCollectError, setEmployeeCollectError] = useState("");
  const scanInputRef = useRef(null);
  const scanTimerRef = useRef(null);
  const [scanValue, setScanValue] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  const labelScanInputRef = useRef(null);
  const labelScanTimerRef = useRef(null);
  const [labelScanValue, setLabelScanValue] = useState("");
  const [labelScanBusy, setLabelScanBusy] = useState(false);
  const [labelScanError, setLabelScanError] = useState("");
  const [labelOpened, setLabelOpened] = useState(false);

  const isAdmin = currentUser?.role === "admin";
  const isSuper = currentUser?.role === "super_admin";
  const isEmployee = currentUser?.role === "employee";
  const usersRoleFilter = isSuper ? (userTab === "admins" ? "admin" : "employee") : "employee";

  const handleAuthError = (err) => {
    if (err?.status === 401) {
      setCurrentUser(null);
      setAuthChecked(true);
      return true;
    }
    return false;
  };

  const storeHeader = useMemo(() => {
    return storeId ? { "X-Store-Id": storeId } : {};
  }, [storeId]);

  const adminFetch = (url, options = {}) => {
    return fetchJson(url, {
      ...options,
      headers: { ...storeHeader, ...(options.headers || {}) },
    });
  };

  const updateSupplyList = (supplyId, patch) => {
    if (!supplyId) return;
    setSupplies((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (item.id !== supplyId) return item;
        let updated = item;
        for (const [key, value] of Object.entries(patch || {})) {
          if (value === undefined) continue;
          if (updated[key] !== value) {
            if (updated === item) updated = { ...item };
            updated[key] = value;
            changed = true;
          }
        }
        return updated;
      });
      return changed ? next : prev;
    });
  };

  useEffect(() => {
    let active = true;
    fetchJson(`${API_BASE}/auth/me`)
      .then((data) => {
        if (!active) return;
        setCurrentUser(data?.user || null);
        setAuthChecked(true);
      })
      .catch((err) => {
        if (!active) return;
        if (err?.status === 401) {
          setCurrentUser(null);
          setAuthChecked(true);
          return;
        }
        setLoginError("Не удалось проверить авторизацию.");
        setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    fetchJson(`${API_BASE}/stores`)
      .then((data) => {
        if (!active) return;
        const stores = Array.isArray(data?.stores) ? data.stores : [];
        setStoreOptions(stores);
        const defaultId = data?.defaultStoreId || stores[0]?.id || "";
        let next = storeId || defaultId;
        if (next && !stores.find((store) => store.id === next)) {
          next = defaultId;
        }
        if (next && next !== storeId) {
          setStoreId(next);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isAdmin, storeId]);

  useEffect(() => {
    if (!isAdmin) return;
    if (storeId) {
      window.localStorage.setItem("wb_store_id", storeId);
    }
  }, [storeId, isAdmin]);

  const handleLogin = async () => {
    setLoginError("");
    const surname = loginSurname.trim();
    if (!surname || !loginPassword) {
      setLoginError("Введите фамилию и пароль.");
      return;
    }
    try {
      setLoginBusy(true);
      const data = await fetchJson(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surname, password: loginPassword }),
      });
      setCurrentUser(data?.user || null);
      setAuthChecked(true);
      setLoginPassword("");
    } catch (err) {
      setLoginError(err?.message || "Не удалось войти.");
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchJson(`${API_BASE}/auth/logout`, { method: "POST" });
    } catch {}
    setCurrentUser(null);
  };

  const loadUsers = async () => {
    if (!currentUser) return;
    setUsersLoading(true);
    setUsersError("");
    try {
      const roleParam = isSuper ? `?role=${usersRoleFilter}` : "";
      const data = await fetchJson(`${API_BASE}/users${roleParam}`);
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (err) {
      if (handleAuthError(err)) return;
      setUsersError("Не удалось загрузить пользователей.");
    } finally {
      setUsersLoading(false);
    }
  };

  const handleCreateUser = async () => {
    setUserActionError("");
    const surname = createUserSurname.trim();
    const name = createUserName.trim();
    if (!surname || !name || !createUserPassword) {
      setUserActionError("Заполните фамилию, имя и пароль.");
      return;
    }
    try {
      setUserActionBusy(true);
      await fetchJson(`${API_BASE}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surname,
          name,
          password: createUserPassword,
          role: usersRoleFilter,
        }),
      });
      setCreateUserSurname("");
      setCreateUserName("");
      setCreateUserPassword("");
      await loadUsers();
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserActionError(err?.message || "Не удалось создать пользователя.");
    } finally {
      setUserActionBusy(false);
    }
  };

  const openEditUser = (user) => {
    setEditUser(user);
    setEditSurname(user?.surname || "");
    setEditName(user?.name || "");
    setEditPassword("");
    setUserActionError("");
  };

  const handleSaveUser = async () => {
    if (!editUser) return;
    setUserActionError("");
    const surname = editSurname.trim();
    const name = editName.trim();
    if (!surname || !name) {
      setUserActionError("Фамилия и имя обязательны.");
      return;
    }
    const payload = { surname, name };
    if (editPassword) payload.password = editPassword;
    try {
      setUserActionBusy(true);
      await fetchJson(`${API_BASE}/users/${editUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setEditUser(null);
      setEditPassword("");
      await loadUsers();
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserActionError(err?.message || "Не удалось сохранить пользователя.");
    } finally {
      setUserActionBusy(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (!user) return;
    if (!window.confirm(`Удалить пользователя ${user.surname}?`)) return;
    setUserActionError("");
    try {
      setUserActionBusy(true);
      await fetchJson(`${API_BASE}/users/${user.id}`, { method: "DELETE" });
      await loadUsers();
    } catch (err) {
      if (handleAuthError(err)) return;
      setUserActionError(err?.message || "Не удалось удалить пользователя.");
    } finally {
      setUserActionBusy(false);
    }
  };

  const loadData = async ({ withNewOrders = true, withSupplies = true, silent = false } = {}) => {
    try {
      if (!silent) setError("");
      const [newData, supplyData] = await Promise.all([
        withNewOrders ? adminFetch(`${API_BASE}/new-orders`) : Promise.resolve(null),
        withSupplies ? adminFetch(`${API_BASE}/supplies`) : Promise.resolve(null),
      ]);
      if (newData) {
        setNewOrders(Array.isArray(newData.orders) ? newData.orders : []);
      }
      if (supplyData) {
        setSupplies(Array.isArray(supplyData.supplies) ? supplyData.supplies : []);
      }
      if (withNewOrders || withSupplies) {
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) setError("Не удалось загрузить данные. Проверьте токен и доступ к API.");
    } finally {
      if (!silent) setBooting(false);
    }
  };

  const loadSupplyOrders = async (supply, { silent = false } = {}) => {
    if (!supply) return;
    if (!silent) {
      setSupplyLoading(true);
      setSupplyError("");
    }
    try {
      const data = await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(supply.id)}/orders`);
      setSupplyOrders(Array.isArray(data.orders) ? data.orders : []);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setSupplyOrders([]);
        setSupplyError("Не удалось загрузить заказы поставки.");
      }
    } finally {
      if (!silent) setSupplyLoading(false);
    }
  };

  const loadSupplySettings = async (supply, { silent = false } = {}) => {
    if (!supply) return;
    if (!silent) {
      setSupplySettingsLoading(true);
      setSupplySettingsError("");
    }
    try {
      const data = await adminFetch(
        `${API_BASE}/supplies/${encodeURIComponent(supply.id)}/settings`
      );
      const accessUserIds = Array.isArray(data?.accessUserIds) ? data.accessUserIds : [];
      const totals = {
        total: Number(data?.totals?.total || 0),
        collected: Number(data?.totals?.collected || 0),
        remaining: Number(data?.totals?.remaining || 0),
      };
      setSupplySettings(data?.settings || null);
      setSupplyAccessMode(data?.settings?.accessMode || "hidden");
      setSupplyAccessUsers(accessUserIds);
      setSupplyEmployees(Array.isArray(data?.employees) ? data.employees : []);
      setSupplyProgress(Array.isArray(data?.progress) ? data.progress : []);
      setSupplyTotals(totals);
      updateSupplyList(supply.id, {
        accessMode: data?.settings?.accessMode,
        accessUserCount: accessUserIds.length,
        orderCount: totals.total,
        collectedCount: totals.collected,
        remainingCount: totals.remaining,
        name: data?.settings?.supplyName || supply.name,
        storeName: data?.settings?.storeName,
      });
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setSupplySettingsError("Не удалось загрузить настройки поставки.");
      }
    } finally {
      if (!silent) setSupplySettingsLoading(false);
    }
  };

  const handleAccessModeChange = async (mode) => {
    if (!selectedSupply) return;
    setSupplyAccessMode(mode);
    setSettingsBusy(true);
    setSupplySettingsError("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessMode: mode }),
      });
      await loadSupplySettings(selectedSupply);
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось сохранить настройки.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSaveAccessUsers = async () => {
    if (!selectedSupply) return;
    setSettingsBusy(true);
    setSupplySettingsError("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: supplyAccessUsers }),
      });
      await loadSupplySettings(selectedSupply);
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось обновить доступ.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSplitSupply = async (mode) => {
    if (!selectedSupply) return;
    setSettingsBusy(true);
    setSupplySettingsError("");
    try {
      const path = mode === "redistribute" ? "redistribute" : "split";
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/${path}`, {
        method: "POST",
      });
      await loadSupplySettings(selectedSupply);
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось распределить поставку.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleResetAccess = async () => {
    if (!selectedSupply) return;
    setSettingsBusy(true);
    setSupplySettingsError("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/reset-access`, {
        method: "POST",
      });
      await loadSupplySettings(selectedSupply);
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось вернуть общий доступ.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleLoadLabels = async () => {
    if (!selectedSupply) return;
    setLabelsBusy(true);
    setSupplySettingsError("");
    try {
      await adminFetch(`${API_BASE}/supplies/${encodeURIComponent(selectedSupply.id)}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplyName: selectedSupply.name || null }),
      });
      await loadSupplySettings(selectedSupply);
    } catch (err) {
      if (handleAuthError(err)) return;
      setSupplySettingsError(err?.message || "Не удалось загрузить этикетки.");
    } finally {
      setLabelsBusy(false);
    }
  };

  const loadLinksWbArticles = async ({ force = false } = {}) => {
    setLinksLoading(true);
    setLinksError("");
    try {
      const qs = force ? "?force=1" : "";
      const data = await adminFetch(`${API_BASE}/links/wb-articles${qs}`);
      const items = Array.isArray(data?.items) ? data.items : [];
      setLinksItems(items);
      setLinksUpdatedAt(data?.updatedAt ? new Date(data.updatedAt) : null);
      setLinksMsByArticle({});
      setLinksMsError("");
      setLinksProgress({ done: 0, total: items.length });
    } catch (err) {
      if (handleAuthError(err)) return;
      setLinksError(err?.message || "Не удалось загрузить артикулы WB.");
    } finally {
      setLinksLoading(false);
    }
  };

  const handleLoadMsLinks = async () => {
    if (linksMsLoading || linksItems.length === 0) return;
    setLinksMsLoading(true);
    setLinksMsError("");
    const articles = Array.from(new Set(linksItems.map((item) => item.article).filter(Boolean)));
    const total = articles.length;
    setLinksProgress({ done: 0, total });
    const batchSize = 50;
    try {
      for (let i = 0; i < articles.length; i += batchSize) {
        const batch = articles.slice(i, i + batchSize);
        const data = await adminFetch(`${API_BASE}/links/ms-barcodes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articles: batch }),
        });
        const items = Array.isArray(data?.items) ? data.items : [];
        setLinksMsByArticle((prev) => {
          const next = { ...prev };
          for (const entry of items) {
            if (!entry?.article) continue;
            next[entry.article] = {
              barcodes: Array.isArray(entry.barcodes) ? entry.barcodes : [],
              missing: entry.missing === true,
              error: entry.error || null,
            };
          }
          return next;
        });
        const done = Math.min(total, i + batchSize);
        setLinksProgress({ done, total });
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      setLinksMsError(err?.message || "Не удалось получить данные из МойСклад.");
    } finally {
      setLinksMsLoading(false);
    }
  };

  const loadEmployeeSupplies = async ({ silent = false } = {}) => {
    if (!silent) {
      setEmployeeSuppliesLoading(true);
      setEmployeeSuppliesError("");
    }
    try {
      const data = await fetchJson(`${API_BASE}/employee/supplies`);
      setEmployeeSupplies(Array.isArray(data?.supplies) ? data.supplies : []);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setEmployeeSuppliesError(err?.message || "Не удалось загрузить поставки.");
      }
    } finally {
      if (!silent) setEmployeeSuppliesLoading(false);
    }
  };

  const loadEmployeeItems = async (supplyId, { silent = false } = {}) => {
    if (!supplyId) return;
    if (!silent) {
      setEmployeeItemsLoading(true);
      setEmployeeItemsError("");
    }
    try {
      const data = await fetchJson(`${API_BASE}/employee/supplies/${encodeURIComponent(supplyId)}/items`);
      setEmployeeItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setEmployeeItemsError(err?.message || "Не удалось загрузить товары.");
      }
    } finally {
      if (!silent) setEmployeeItemsLoading(false);
    }
  };

  const loadEmployeeOrders = async (supplyId, item, { silent = false } = {}) => {
    if (!supplyId || !item) return;
    if (!silent) {
      setEmployeeOrdersLoading(true);
      setEmployeeOrdersError("");
    }
    try {
      const params = new URLSearchParams();
      if (item.article) params.set("article", item.article);
      if (item.barcode) params.set("barcode", item.barcode);
      if (item.nmId) params.set("nmId", item.nmId);
      const qs = params.toString();
      const data = await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(supplyId)}/orders${qs ? `?${qs}` : ""}`
      );
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      setEmployeeOrders(
        orders.map((order) => ({
          ...order,
          scanPassed: Boolean(order.scanPassedAt),
          labelScanPassed: Boolean(order.labelScanPassedAt),
        }))
      );
    } catch (err) {
      if (handleAuthError(err)) return;
      if (!silent) {
        setEmployeeOrdersError(err?.message || "Не удалось загрузить заказы.");
      }
    } finally {
      if (!silent) setEmployeeOrdersLoading(false);
    }
  };

  const handleCollectOrder = (order) => {
    if (!employeeSelectedSupply || !order) return;
    if (!order.scanPassed) {
      setEmployeeCollectError("Безошибочная сборка не пройдена.");
      return;
    }
    if (!order.stickerUrl) {
      setEmployeeCollectError("Этикетка не загружена.");
      return;
    }
    setEmployeeCollectError("");
    window.open(order.stickerUrl, "_blank", "noopener");
    setLabelOpened(true);
  };

  const handleScanSubmit = async (order, value) => {
    if (!employeeSelectedSupply || !order) return;
    if (scanBusy) return;
    const barcode = value.trim();
    if (!barcode) return;
    setScanBusy(true);
    setScanError("");
    try {
      await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/orders/${order.id}/scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      setEmployeeSelectedOrder((prev) =>
        prev ? { ...prev, scanPassed: true, scanPassedAt: new Date().toISOString(), scanBarcode: barcode } : prev
      );
      setEmployeeOrders((list) =>
        list.map((item) =>
          item.id === order.id
            ? { ...item, scanPassed: true, scanPassedAt: new Date().toISOString(), scanBarcode: barcode }
            : item
        )
      );
      setScanValue("");
    } catch (err) {
      setScanError("Отсканируйте повторно");
      setScanValue("");
      if (scanInputRef.current) {
        scanInputRef.current.focus();
      }
    } finally {
      setScanBusy(false);
    }
  };

  const handleLabelScanSubmit = async (order, value) => {
    if (!employeeSelectedSupply || !order) return;
    if (labelScanBusy) return;
    const barcode = value.trim();
    if (!barcode) return;
    setLabelScanBusy(true);
    setLabelScanError("");
    try {
      await fetchJson(
        `${API_BASE}/employee/supplies/${encodeURIComponent(employeeSelectedSupply.id)}/orders/${order.id}/label-scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ barcode }),
        }
      );
      const nowIso = new Date().toISOString();
      setEmployeeSelectedOrder((prev) =>
        prev
          ? {
              ...prev,
              labelScanPassed: true,
              labelScanPassedAt: nowIso,
              labelScanBarcode: barcode,
            }
          : prev
      );
      setEmployeeOrders((list) =>
        list.map((item) =>
          item.id === order.id
            ? {
                ...item,
                labelScanPassed: true,
                labelScanPassedAt: nowIso,
                labelScanBarcode: barcode,
              }
            : item
        )
      );
      setLabelScanValue("");
      await Promise.all([
        loadEmployeeOrders(employeeSelectedSupply.id, employeeSelectedItem),
        loadEmployeeItems(employeeSelectedSupply.id),
        loadEmployeeSupplies(),
      ]);
      setEmployeeSelectedOrder(null);
    } catch (err) {
      setLabelScanError("Отсканируйте повторно");
      setLabelScanValue("");
      if (labelScanInputRef.current) {
        labelScanInputRef.current.focus();
      }
    } finally {
      setLabelScanBusy(false);
    }
  };

  useEffect(() => {
    liveStateRef.current = {
      isAdmin,
      isEmployee,
      tab,
      createOpen,
      selectedSupply,
      supplyTab,
      employeeSelectedSupply,
      employeeSelectedItem,
    };
  }, [
    isAdmin,
    isEmployee,
    tab,
    createOpen,
    selectedSupply,
    supplyTab,
    employeeSelectedSupply,
    employeeSelectedItem,
  ]);

  const scheduleLiveRefresh = () => {
    if (liveTimerRef.current) return;
    liveTimerRef.current = setTimeout(() => {
      liveTimerRef.current = null;
      const state = liveStateRef.current;
      if (!state) return;
      if (state.isAdmin) {
        const withNewOrders = state.tab === "new" || state.createOpen;
        loadData({ withNewOrders, withSupplies: true, silent: true });
        if (state.selectedSupply) {
          loadSupplySettings(state.selectedSupply, { silent: true });
          if (state.supplyTab !== "settings") {
            loadSupplyOrders(state.selectedSupply, { silent: true });
          }
        }
      }
      if (state.isEmployee) {
        loadEmployeeSupplies({ silent: true });
        if (state.employeeSelectedSupply) {
          loadEmployeeItems(state.employeeSelectedSupply.id, { silent: true });
          if (state.employeeSelectedItem) {
            loadEmployeeOrders(
              state.employeeSelectedSupply.id,
              state.employeeSelectedItem,
              { silent: true }
            );
          }
        }
      }
    }, 200);
  };

  useEffect(() => {
    if (!currentUser) return;
    const source = new EventSource(`${API_BASE}/events`);
    const handleEvent = () => scheduleLiveRefresh();
    source.addEventListener("supply_update", handleEvent);
    source.addEventListener("labels_progress", handleEvent);
    source.addEventListener("order_collected", handleEvent);
    source.onmessage = handleEvent;
    source.onerror = () => {};
    scheduleLiveRefresh();
    return () => {
      source.close();
    };
  }, [currentUser, storeId, isAdmin, isEmployee]);

  useEffect(() => {
    const handleFocus = () => scheduleLiveRefresh();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        scheduleLiveRefresh();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [storeId]);

  useEffect(() => {
    return () => {
      if (liveTimerRef.current) {
        clearTimeout(liveTimerRef.current);
        liveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    loadData({ withNewOrders: false, withSupplies: true });
    const timer = setInterval(() => {
      loadData({ withNewOrders: false, withSupplies: true, silent: true });
    }, REFRESH_SUPPLIES_MS);
    return () => clearInterval(timer);
  }, [isAdmin, storeId]);

  useEffect(() => {
    if (!isAdmin || !storeId) return;
    setSelectedSupply(null);
    setCreateOpen(false);
    setNewOrders([]);
    setSupplies([]);
    setSupplyOrders([]);
    setSupplySettings(null);
    setSupplyAccessUsers([]);
    setSupplyEmployees([]);
    setSupplyProgress([]);
    setSupplyTotals({ total: 0, collected: 0, remaining: 0 });
    setLastUpdated(null);
    const withNewOrders = tab === "new" || createOpen;
    loadData({ withNewOrders, withSupplies: true });
  }, [isAdmin, storeId]);

  useEffect(() => {
    if (!isAdmin) return;
    if (!(tab === "new" || createOpen)) return;
    loadData({ withNewOrders: true, withSupplies: false });
    const timer = setInterval(() => {
      loadData({ withNewOrders: true, withSupplies: false, silent: true });
    }, REFRESH_NEW_ORDERS_MS);
    return () => clearInterval(timer);
  }, [isAdmin, tab, createOpen, storeId]);

  useEffect(() => {
    if (!isAdmin || !selectedSupply) return;
    loadSupplyOrders(selectedSupply);
    loadSupplySettings(selectedSupply);
  }, [selectedSupply, isAdmin]);

  useEffect(() => {
    if (!isAdmin || !selectedSupply) return;
    const timer = setInterval(() => {
      loadSupplySettings(selectedSupply, { silent: true });
      if (supplyTab !== "settings") {
        loadSupplyOrders(selectedSupply, { silent: true });
      }
    }, REFRESH_FAST_MS);
    return () => clearInterval(timer);
  }, [isAdmin, selectedSupply, supplyTab, storeId]);

  useEffect(() => {
    if (!isAdmin || tab !== "links") return;
    loadLinksWbArticles();
  }, [isAdmin, tab, storeId]);

  useEffect(() => {
    if (selectedSupply) {
      setSupplyTab("orders");
    }
  }, [selectedSupply]);

  useEffect(() => {
    if (selectedSupply) return;
    setSupplySettings(null);
    setSupplyAccessUsers([]);
    setSupplyEmployees([]);
    setSupplyProgress([]);
    setSupplyTotals({ total: 0, collected: 0, remaining: 0 });
    setSupplySettingsError("");
  }, [selectedSupply]);

  useEffect(() => {
    const pages = Math.max(1, Math.ceil(newOrders.length / PAGE_SIZE));
    setPage((prev) => Math.min(prev, pages));
  }, [newOrders.length]);

  useEffect(() => {
    if (!currentUser) return;
    if (isSuper) {
      loadUsers();
    }
  }, [currentUser, isAdmin, isSuper, tab, userTab]);

  useEffect(() => {
    if (!currentUser || !isAdmin) return;
    loadUsers();
    const timer = setInterval(() => {
      loadUsers();
    }, 15000);
    return () => clearInterval(timer);
  }, [currentUser, isAdmin]);

  useEffect(() => {
    if (isAdmin) return;
    setNewOrders([]);
    setSupplies([]);
    setSelectedSupply(null);
  }, [isAdmin]);

  useEffect(() => {
    if (!isEmployee) return;
    loadEmployeeSupplies();
    const timer = setInterval(() => {
      loadEmployeeSupplies({ silent: true });
    }, REFRESH_FAST_MS);
    return () => clearInterval(timer);
  }, [isEmployee]);

  useEffect(() => {
    if (!employeeSelectedSupply) return;
    setEmployeeSelectedItem(null);
    setEmployeeSelectedOrder(null);
    loadEmployeeItems(employeeSelectedSupply.id);
  }, [employeeSelectedSupply]);

  useEffect(() => {
    if (employeeSelectedSupply) return;
    setEmployeeItems([]);
    setEmployeeOrders([]);
    setEmployeeSelectedItem(null);
    setEmployeeSelectedOrder(null);
  }, [employeeSelectedSupply]);

  useEffect(() => {
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (labelScanTimerRef.current) {
      clearTimeout(labelScanTimerRef.current);
      labelScanTimerRef.current = null;
    }
    setScanValue("");
    setScanError("");
    setScanBusy(false);
    setLabelScanValue("");
    setLabelScanError("");
    setLabelScanBusy(false);
    setLabelOpened(false);
    if (employeeSelectedOrder && !employeeSelectedOrder.scanPassed) {
      setTimeout(() => {
        if (scanInputRef.current) {
          scanInputRef.current.focus();
        }
      }, 50);
    }
  }, [employeeSelectedOrder]);

  useEffect(() => {
    if (!employeeSelectedOrder || employeeSelectedOrder.scanPassed) return;
    const value = scanValue.trim();
    if (!value) return;
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = setTimeout(() => {
      scanTimerRef.current = null;
      handleScanSubmit(employeeSelectedOrder, value);
    }, 200);
  }, [scanValue, employeeSelectedOrder]);

  useEffect(() => {
    if (!employeeSelectedOrder || !employeeSelectedOrder.scanPassed) return;
    if (employeeSelectedOrder.labelScanPassed) return;
    if (!labelOpened) return;
    setTimeout(() => {
      if (labelScanInputRef.current) {
        labelScanInputRef.current.focus();
      }
    }, 50);
  }, [employeeSelectedOrder, labelOpened]);

  useEffect(() => {
    if (!employeeSelectedOrder || !employeeSelectedOrder.scanPassed) return;
    if (employeeSelectedOrder.labelScanPassed) return;
    if (!labelOpened) return;
    const value = labelScanValue.trim();
    if (!value) return;
    if (labelScanTimerRef.current) clearTimeout(labelScanTimerRef.current);
    labelScanTimerRef.current = setTimeout(() => {
      labelScanTimerRef.current = null;
      handleLabelScanSubmit(employeeSelectedOrder, value);
    }, 200);
  }, [labelScanValue, employeeSelectedOrder, labelOpened]);

  useEffect(() => {
    if (!employeeSelectedSupply || !employeeSelectedItem) return;
    setEmployeeSelectedOrder(null);
    loadEmployeeOrders(employeeSelectedSupply.id, employeeSelectedItem);
  }, [employeeSelectedItem, employeeSelectedSupply]);

  useEffect(() => {
    if (!isEmployee || !employeeSelectedSupply) return;
    const timer = setInterval(() => {
      loadEmployeeItems(employeeSelectedSupply.id, { silent: true });
    }, REFRESH_FAST_MS);
    return () => clearInterval(timer);
  }, [isEmployee, employeeSelectedSupply]);

  useEffect(() => {
    if (!isEmployee || !employeeSelectedSupply || !employeeSelectedItem) return;
    const timer = setInterval(() => {
      loadEmployeeOrders(employeeSelectedSupply.id, employeeSelectedItem, { silent: true });
    }, REFRESH_FAST_MS);
    return () => clearInterval(timer);
  }, [isEmployee, employeeSelectedSupply, employeeSelectedItem]);

  
  const safeCreateCount = Math.max(1, Number(createCount) || 1);
  const selection = useMemo(
    () => pickOrders(newOrders, createSort, safeCreateCount),
    [newOrders, createSort, safeCreateCount]
  );

  const newItems = useMemo(() => {
    const map = new Map();
    for (const order of newOrders) {
      const name = order.productName || order.article || "—";
      const barcode = order.barcode || "—";
      const article = order.article || "—";
      const nmId = order.nmId || "—";
      const key = `${name}||${barcode}||${article}||${nmId}`;
      const rawQty = Number(order.quantity ?? 1);
      const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
      const entry = map.get(key) || { name, barcode, article, nmId, count: 0 };
      entry.count += qty;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [newOrders]);

  const supplyItems = useMemo(() => {
    const map = new Map();
    for (const order of supplyOrders) {
      const name = order.productName || order.article || "—";
      const barcode = order.barcode || "—";
      const article = order.article || "—";
      const nmId = order.nmId || "—";
      const key = `${name}||${barcode}||${article}||${nmId}`;
      const rawQty = Number(order.quantity ?? 1);
      const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
      const entry = map.get(key) || { name, barcode, article, nmId, count: 0 };
      entry.count += qty;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [supplyOrders]);

  const articleMap = useMemo(() => {
    const map = new Map();
    for (const order of newOrders) {
      const article = order.article;
      if (!article) continue;
      const entry =
        map.get(article) || {
          article,
          name: order.productName || "",
          barcode: order.barcode || "",
          nmId: order.nmId || "",
          orders: [],
        };
      entry.orders.push(order);
      if (!entry.name && order.productName) entry.name = order.productName;
      if (!entry.barcode && order.barcode) entry.barcode = order.barcode;
      if (!entry.nmId && order.nmId) entry.nmId = order.nmId;
      map.set(article, entry);
    }
    for (const entry of map.values()) {
      entry.orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }
    return map;
  }, [newOrders]);

  const articleOptions = useMemo(
    () => Array.from(articleMap.values()).sort((a, b) => b.orders.length - a.orders.length),
    [articleMap]
  );

  const articleSelection = useMemo(
    () => buildArticleSelection(articleRows, articleMap),
    [articleRows, articleMap]
  );

  const articleRequested = useMemo(
    () => articleRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0),
    [articleRows]
  );
  useEffect(() => {
    if (articleOptions.length === 0) return;
    setArticleRows((rows) =>
      rows.map((row) => {
        if (row.article && articleMap.has(row.article)) return row;
        const first = articleOptions[0];
        const max = first?.orders?.length || 0;
        return {
          ...row,
          article: first.article,
          count: Math.min(Math.max(1, row.count || 1), max || 1),
        };
      })
    );
  }, [articleOptions, articleMap]);

  useEffect(() => {
    setArticleRows((rows) => {
      let changed = false;
      const next = rows.map((row) => {
        const available =
          row.article && articleSelection.availableByArticle.get(row.article)
            ? articleSelection.availableByArticle.get(row.article)
            : 0;
        const target =
          available === 0 ? 0 : Math.min(Math.max(1, Number(row.count) || 1), available);
        if (row.count !== target) {
          changed = true;
          return { ...row, count: target };
        }
        return row;
      });
      return changed ? next : rows;
    });
  }, [articleSelection.availableByArticle]);

  const totalPages = Math.max(1, Math.ceil(newOrders.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;
  const pagedOrders = newOrders.slice(pageStart, pageEnd);
  const pageFrom = newOrders.length ? pageStart + 1 : 0;
  const pageTo = Math.min(pageEnd, newOrders.length);
  const canCreate =
    createMode === "articles"
      ? articleSelection.selected.length > 0
      : selection.selected.length > 0;
  const requestedCount = createMode === "articles" ? articleRequested : safeCreateCount;
  const selectedCount =
    createMode === "articles" ? articleSelection.selected.length : selection.selected.length;
  const hasLimitWarning = selectedCount < requestedCount;

  const labelsTotal = Number(supplySettings?.labelsTotal || 0);
  const labelsLoaded = Number(supplySettings?.labelsLoaded || 0);
  const labelsProgress = labelsTotal > 0 ? Math.min(100, Math.round((labelsLoaded / labelsTotal) * 100)) : 0;
  const hasAssignments = supplyProgress.some((entry) => entry.total && entry.total > 0);

  const handleExportItems = async () => {
    if (!supplyItems.length || !selectedSupply) return;
    try {
      const XLSX = await import("xlsx");
      const rows = supplyItems.map((item) => ({
        "Название": item.name || "",
        "Баркод": item.barcode || "",
        "Артикул продавца": item.article || "",
        "Артикул WB": item.nmId || "",
        "Кол-во": item.count || 0,
      }));
      const header = ["Название", "Баркод", "Артикул продавца", "Артикул WB", "Кол-во"];
      const sheet = XLSX.utils.json_to_sheet(rows, { header });
      sheet["!cols"] = [
        { wch: 40 },
        { wch: 20 },
        { wch: 20 },
        { wch: 18 },
        { wch: 10 },
      ];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, "Товары");
      const data = XLSX.write(book, { bookType: "xlsx", type: "array" });
      const blob = new Blob([data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `supply_${selectedSupply.id}_items.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Excel export failed", err);
    }
  };

  const handleCreateSupply = async () => {
    setCreateError("");
    setCreateSuccess("");
    setCreateWarning("");
    if (!createName.trim()) {
      setCreateError("Введите название поставки.");
      return;
    }
    const selectedOrders =
      createMode === "articles" ? articleSelection.selected : selection.selected;
    if (!selectedOrders.length) {
      setCreateError("Нет доступных заказов для добавления.");
      return;
    }
    try {
      setCreateBusy(true);
      const payload = {
        name: createName.trim(),
        orders: selectedOrders.map((o) => o.id),
      };
      const data = await adminFetch(`${API_BASE}/supplies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const addedCount = Number(data?.addedCount ?? 0);
      const failedCount = Number(data?.failedCount ?? 0);
      const failedReason = data?.failedReason ? String(data.failedReason) : "";
      const failedIds = Array.isArray(data?.failedIds) ? data.failedIds : [];
      if (failedCount > 0) {
        const reasonText = failedReason ? ` Причина: ${failedReason}` : "";
        const idsText = failedIds.length ? ` Примеры ID: ${failedIds.join(", ")}` : "";
        setCreateWarning(
          `Поставка создана: ${data.supplyId}. Добавлено ${addedCount}, не добавлено ${failedCount}.${reasonText}${idsText}`
        );
        if (addedCount > 0) {
          setCreateOpen(false);
          setCreateName("");
          await loadData();
        }
        return;
      }
      setCreateSuccess(`Поставка создана: ${data.supplyId}`);
      setCreateOpen(false);
      setCreateName("");
      await loadData();
    } catch (err) {
      setCreateError(err?.message || "Не удалось создать поставку. Проверьте доступы и заказы.");
    } finally {
      setCreateBusy(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="app">
        <section className="card">
          <div className="empty">Проверяем доступ…</div>
        </section>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginView
        loginSurname={loginSurname}
        setLoginSurname={setLoginSurname}
        loginPassword={loginPassword}
        setLoginPassword={setLoginPassword}
        loginError={loginError}
        loginBusy={loginBusy}
        handleLogin={handleLogin}
      />
    );
  }

  if (isSuper) {
    return (
      <SuperAdminView
        currentUser={currentUser}
        userTab={userTab}
        setUserTab={setUserTab}
        users={users}
        usersLoading={usersLoading}
        usersError={usersError}
        userActionError={userActionError}
        userActionBusy={userActionBusy}
        createUserSurname={createUserSurname}
        setCreateUserSurname={setCreateUserSurname}
        createUserName={createUserName}
        setCreateUserName={setCreateUserName}
        createUserPassword={createUserPassword}
        setCreateUserPassword={setCreateUserPassword}
        handleCreateUser={handleCreateUser}
        handleLogout={handleLogout}
        openEditUser={openEditUser}
        handleDeleteUser={handleDeleteUser}
        editUser={editUser}
        setEditUser={setEditUser}
        editSurname={editSurname}
        setEditSurname={setEditSurname}
        editName={editName}
        setEditName={setEditName}
        editPassword={editPassword}
        setEditPassword={setEditPassword}
        handleSaveUser={handleSaveUser}
        formatDate={formatDate}
      />
    );
  }

  if (isEmployee) {
    return (
      <EmployeeView
        currentUser={currentUser}
        handleLogout={handleLogout}
        employeeSuppliesError={employeeSuppliesError}
        employeeSuppliesLoading={employeeSuppliesLoading}
        employeeSupplies={employeeSupplies}
        employeeSelectedSupply={employeeSelectedSupply}
        setEmployeeSelectedSupply={setEmployeeSelectedSupply}
        employeeSelectedOrder={employeeSelectedOrder}
        setEmployeeSelectedOrder={setEmployeeSelectedOrder}
        employeeSelectedItem={employeeSelectedItem}
        setEmployeeSelectedItem={setEmployeeSelectedItem}
        employeeOrders={employeeOrders}
        employeeOrdersLoading={employeeOrdersLoading}
        employeeOrdersError={employeeOrdersError}
        employeeItems={employeeItems}
        employeeItemsLoading={employeeItemsLoading}
        employeeItemsError={employeeItemsError}
        labelScanInputRef={labelScanInputRef}
        labelScanValue={labelScanValue}
        setLabelScanValue={setLabelScanValue}
        labelOpened={labelOpened}
        labelScanBusy={labelScanBusy}
        labelScanError={labelScanError}
        scanInputRef={scanInputRef}
        scanValue={scanValue}
        setScanValue={setScanValue}
        scanBusy={scanBusy}
        scanError={scanError}
        handleCollectOrder={handleCollectOrder}
        employeeCollectError={employeeCollectError}
        formatDate={formatDate}
        timeAgo={timeAgo}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">WB Склад</div>
            <div className="subtitle">FBS • обновление каждые 30 секунд</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="status">
            {lastUpdated ? `Обновлено: ${lastUpdated.toLocaleTimeString("ru-RU")}` : "—"}
          </div>
          {storeOptions.length > 0 && (
            <label className="store-select">
              <span>Магазин</span>
              <select
                className="input store-input"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
              >
                {storeOptions.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="user-chip">
            <div className="user-name">{currentUser.surname} {currentUser.name}</div>
            <div className="user-role">Админ</div>
          </div>
          <button className="ghost-button small" type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      <div className="tabs">
        <button
          className={`tab ${tab === "new" ? "active" : ""}`}
          onClick={() => setTab("new")}
          type="button"
        >
          Новые
          <span className="badge">{newOrders.length}</span>
        </button>
        <button
          className={`tab ${tab === "assembling" ? "active" : ""}`}
          onClick={() => setTab("assembling")}
          type="button"
        >
          На сборке
          <span className="badge">{supplies.length}</span>
        </button>
        <button
          className={`tab ${tab === "employees" ? "active" : ""}`}
          onClick={() => setTab("employees")}
          type="button"
        >
          Сотрудники
          <span className="badge">{users.length}</span>
        </button>
        <button
          className={`tab ${tab === "links" ? "active" : ""}`}
          onClick={() => setTab("links")}
          type="button"
        >
          Связи
        </button>
      </div>

      {error && <div className="alert">{error}</div>}
      {createSuccess && <div className="alert success">{createSuccess}</div>}
      {createWarning && <div className="alert warn">{createWarning}</div>}

      {tab === "assembling" && (
        <div className="actions">
          <div className="actions-left">
            <button
              className="primary-button"
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={newOrders.length === 0}
            >
              Создать новую поставку
            </button>
            <div className="hint">Добавляем заказы из вкладки «Новые» без ручного клика.</div>
          </div>
        </div>
      )}

      <section className="card">
        {tab === "links" ? (
          <>
            <div className="section-header">
              <div className="section-title">Связи WB → МойСклад</div>
              <div className="hint">Сопоставление артикулов продавца и штрихкодов.</div>
            </div>
            <div className="actions">
              <div className="actions-left">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => loadLinksWbArticles({ force: true })}
                  disabled={linksLoading || linksMsLoading}
                >
                  Обновить из WB
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={handleLoadMsLinks}
                  disabled={linksLoading || linksMsLoading || linksItems.length === 0}
                >
                  Найти в МойСклад
                </button>
                <div className="hint">
                  {linksItems.length > 0 ? `Артикулов WB: ${linksItems.length}` : "Артикулы не загружены"}
                  {linksProgress.total > 0 ? ` • Проверено ${linksProgress.done} / ${linksProgress.total}` : ""}
                  {linksUpdatedAt ? ` • Обновлено: ${linksUpdatedAt.toLocaleTimeString("ru-RU")}` : ""}
                </div>
              </div>
            </div>
            {linksError && <div className="alert small">{linksError}</div>}
            {linksMsError && <div className="alert small">{linksMsError}</div>}
            <div className="list links">
              <div className="list-header">
                <div className="col">Артикул WB</div>
                <div className="col">Штрихкоды МойСклад</div>
              </div>
              <div className="list-body">
                {linksLoading ? (
                  <div className="empty">Загрузка…</div>
                ) : linksItems.length === 0 ? (
                  <div className="empty">Нет данных из WB</div>
                ) : (
                  linksItems.map((item) => {
                    const msInfo = linksMsByArticle[item.article];
                    const missing = msInfo?.missing === true;
                    const barcodes = Array.isArray(msInfo?.barcodes) ? msInfo.barcodes : [];
                    const msText = msInfo
                      ? missing
                        ? "Отсутствует в МойСклад"
                        : barcodes.length
                        ? barcodes.join(", ")
                        : "—"
                      : linksMsLoading
                      ? "Проверяем…"
                      : "—";
                    return (
                      <div className={`row ${missing ? "missing" : ""}`} key={item.article}>
                        <div className={`col mono ${missing ? "text-danger" : ""}`}>{item.article}</div>
                        <div className={`col mono ${missing ? "text-danger" : ""}`}>{msText}</div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </>
        ) : tab === "employees" ? (
          <>
            <div className="section-header">
              <div className="section-title">Сотрудники</div>
              <div className="hint">Управление доступом</div>
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
                  <div className="empty">Пока нет сотрудников</div>
                ) : (
                  users.map((user) => (
                    <div className="row" key={user.id}>
                      <div className="col">
                        <div className="primary">{user.surname}</div>
                      </div>
                      <div className="col">{user.name}</div>
                      <div className="col mono">Сотрудник</div>
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
          </>
        ) : booting ? (
          <div className="empty">Загрузка данных…</div>
        ) : tab === "new" ? (
          <>
          <div className="list orders new-orders">
            <div className="list-header">
              <div className="col check" />
              <div className="col">Заказ</div>
              <div className="col">Название</div>
              <div className="col">Баркод</div>
              <div className="col">Артикул продавца</div>
              <div className="col">Артикул WB</div>
              <div className="col right">Создан</div>
            </div>
            <div className="list-body">
              {newOrders.length === 0 ? (
                <div className="empty">Нет новых сборочных заданий</div>
              ) : (
                pagedOrders.map((order) => (
                  <div className="row" key={order.id}>
                    <div className="col check">
                      <input type="checkbox" aria-label="Выбрать" />
                    </div>
                    <div className="col">
                      <div className="primary">{order.id}</div>
                      <div className="muted">{formatDate(order.createdAt)}</div>
                    </div>
                    <div className="col">
                      <div className="primary">{order.productName || "—"}</div>
                    </div>
                    <div className="col mono">{order.barcode || "—"}</div>
                    <div className="col mono">{order.article || "—"}</div>
                    <div className="col mono">{order.nmId || "—"}</div>
                    <div className="col right">
                      <span className="pill">{timeAgo(order.createdAt)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          {newOrders.length > 0 && (
            <div className="pagination">
              <div className="page-info">
                Показано <strong>{pageFrom}–{pageTo}</strong> из {newOrders.length}
              </div>
              <div className="page-controls">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setPage(Math.max(1, safePage - 1))}
                  disabled={safePage === 1}
                >
                  Назад
                </button>
                <div className="page-indicator">
                  Стр. {safePage} / {totalPages}
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  disabled={safePage === totalPages}
                >
                  Вперёд
                </button>
              </div>
            </div>
          )}
          </>
        ) : (
          <div className="list supplies">
            <div className="list-header">
              <div className="col check" />
              <div className="col">Поставка</div>
              <div className="col">QR-код поставки</div>
              <div className="col right">Кол-во заказов</div>
            </div>
            <div className="list-body">
              {supplies.length === 0 ? (
                <div className="empty">Нет поставок на сборке</div>
              ) : (
                supplies.map((supply) => (
                  <button
                    className="row row-button"
                    key={supply.id}
                    type="button"
                    onClick={() => setSelectedSupply(supply)}
                  >
                    <div className="col check">
                      <input type="checkbox" aria-label="Выбрать" onClick={(e) => e.stopPropagation()} />
                    </div>
                    <div className="col">
                      <div className="primary">{supply.name || `Поставка ${supply.id}`}</div>
                      <div className="muted">
                        {formatDate(supply.createdAt)}
                        {supplyAccessLabel(supply) ? ` \u00b7 ${supplyAccessLabel(supply)}` : ""}
                      </div>
                    </div>
                    <div className="col mono">{supply.id}</div>
                    <div className="col right">
                      <span className="count">{supply.orderCount ?? 0}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </section>

      {selectedSupply && (
        <div className="modal-backdrop" onClick={() => setSelectedSupply(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Поставка {selectedSupply.id}</div>
                <div className="modal-subtitle">
                  {supplyTab === "items"
                    ? "Товары в поставке"
                    : supplyTab === "settings"
                    ? "Настройки поставки"
                    : "Заказы в поставке"}
                </div>
              </div>
              <div className="modal-actions-inline">
                {supplyTab === "items" && (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={handleExportItems}
                    disabled={supplyItems.length === 0}
                  >
                    Экспорт в Excel
                  </button>
                )}
                <button className="icon-button" onClick={() => setSelectedSupply(null)} type="button">
                  {"\u00d7"}
                </button>
              </div>
            </div>

            <div className="modal-tabs">
              <button
                className={`modal-tab ${supplyTab === "orders" ? "active" : ""}`}
                type="button"
                onClick={() => setSupplyTab("orders")}
              >
                Заказы
              </button>
              <button
                className={`modal-tab ${supplyTab === "items" ? "active" : ""}`}
                type="button"
                onClick={() => setSupplyTab("items")}
              >
                Товары
              </button>
              <button
                className={`modal-tab ${supplyTab === "settings" ? "active" : ""}`}
                type="button"
                onClick={() => setSupplyTab("settings")}
              >
                Настройка
              </button>
            </div>

            {supplyTab === "settings" ? (
              supplySettingsLoading ? (
                <div className="empty">Загрузка настроек…</div>
              ) : supplySettingsError ? (
                <div className="empty error">{supplySettingsError}</div>
              ) : (
                <div className="settings-grid">
                  <div className="settings-card">
                    <div className="section-title">Доступ к поставке</div>
                    <div className="mode-toggle">
                      {[
                        { value: "hidden", label: "Скрыта" },
                        { value: "all", label: "Всем" },
                        { value: "selected", label: "Выбранным" },
                        { value: "selected_split", label: "Выбранным с разделением" },
                      ].map((mode) => (
                        <button
                          key={mode.value}
                          type="button"
                          className={`chip ${supplyAccessMode === mode.value ? "active" : ""}`}
                          onClick={() => handleAccessModeChange(mode.value)}
                          disabled={settingsBusy}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>

                    {(supplyAccessMode === "selected" || supplyAccessMode === "selected_split") && (
                      <div className="section">
                        <div className="section-title">Сотрудники</div>
                        <div className="employee-grid">
                          {supplyEmployees.length === 0 ? (
                            <div className="empty">Нет сотрудников</div>
                          ) : (
                            supplyEmployees.map((user) => (
                              <label className="employee-chip" key={user.id}>
                                <input
                                  type="checkbox"
                                  checked={supplyAccessUsers.includes(user.id)}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? Array.from(new Set([...supplyAccessUsers, user.id]))
                                      : supplyAccessUsers.filter((id) => id !== user.id);
                                    setSupplyAccessUsers(next);
                                  }}
                                />
                                <span>{user.surname} {user.name}</span>
                              </label>
                            ))
                          )}
                        </div>
                        <button
                          className="primary-button"
                          type="button"
                          onClick={handleSaveAccessUsers}
                          disabled={settingsBusy}
                        >
                          Сохранить доступ
                        </button>
                      </div>
                    )}

                    {supplyAccessMode === "selected_split" && (
                      <div className="section">
                        <div className="section-title">Распределение</div>
                        <div className="settings-actions">
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => handleSplitSupply("split")}
                            disabled={settingsBusy || supplyAccessUsers.length === 0}
                          >
                            Разделить
                          </button>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => handleSplitSupply("redistribute")}
                            disabled={settingsBusy || supplyAccessUsers.length === 0 || !hasAssignments}
                          >
                            Перераздать
                          </button>
                        </div>
                      </div>
                    )}

                    {supplyAccessMode !== "all" && (
                      <button
                        className="ghost-button small"
                        type="button"
                        onClick={handleResetAccess}
                        disabled={settingsBusy}
                      >
                        Вернуть в общий доступ
                      </button>
                    )}
                  </div>

                  <div className="settings-card">
                    <div className="section-title">Этикетки</div>
                    <div className="progress">
                      <span style={{ width: `${labelsProgress}%` }} />
                    </div>
                    <div className="hint">
                      Загружено: {labelsLoaded} / {labelsTotal}
                    </div>
                    {supplySettings?.labelsStatus === "ready" && (
                      <div className="hint small success">Этикетки готовы</div>
                    )}
                    {supplySettings?.labelsStatus === "error" && supplySettings?.labelsError && (
                      <div className="alert small">{supplySettings.labelsError}</div>
                    )}
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleLoadLabels}
                      disabled={labelsBusy || supplySettings?.labelsStatus === "loading"}
                    >
                      Получить этикетки
                    </button>
                    {supplySettings?.labelsStatus === "loading" && (
                      <div className="hint small">Идёт загрузка…</div>
                    )}
                  </div>

                  <div className="settings-card">
                    <div className="section-title">Прогресс сотрудников</div>
                    <div className="hint small">
                      Собрано: {supplyTotals.collected} / {supplyTotals.total}
                    </div>
                    {supplyTotals.total > 0 && supplyTotals.remaining === 0 && (
                      <div className="hint small success">Все собрано</div>
                    )}
                    <div className="progress-list">
                      {supplyProgress.length === 0 ? (
                        <div className="empty">Нет данных по сборке</div>
                      ) : (
                        supplyProgress.map((entry) => (
                          <div className="progress-row" key={entry.userId}>
                            <div className="primary">{entry.surname} {entry.name}</div>
                            <div className="pill">
                              {entry.total != null
                                ? `${entry.collected || 0} / ${entry.total}`
                                : `Собрано ${entry.collected || 0}`}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )
            ) : supplyLoading ? (
              <div className="empty">Загрузка…</div>
            ) : supplyError ? (
              <div className="empty error">{supplyError}</div>
            ) : supplyTab === "items" ? (
              <div className="list items compact">
                <div className="list-header">
                  <div className="col">Название</div>
                  <div className="col">Баркод</div>
                  <div className="col">Артикул продавца</div>
                  <div className="col">Артикул WB</div>
                  <div className="col right">Кол-во</div>
                </div>
                <div className="list-body">
                  {supplyItems.length === 0 ? (
                    <div className="empty">Нет товаров в этой поставке</div>
                  ) : (
                    supplyItems.map((item) => (
                      <div className="row" key={`${item.name || "—"}-${item.barcode || "—"}-${item.article || "—"}-${item.nmId || "—"}`}>
                        <div className="col">
                          <div className="primary">{item.name || "—"}</div>
                        </div>
                        <div className="col mono">{item.barcode || "—"}</div>
                        <div className="col mono">{item.article || "—"}</div>
                        <div className="col mono">{item.nmId || "—"}</div>
                        <div className="col right">
                          <span className="count">{item.count}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="list orders compact">
                <div className="list-header">
                  <div className="col check" />
                  <div className="col">Заказ</div>
                  <div className="col">Артикул продавца</div>
                  <div className="col">Артикул WB</div>
                  <div className="col right">Создан</div>
                </div>
                <div className="list-body">
                  {supplyOrders.length === 0 ? (
                    <div className="empty">Нет заказов в этой поставке</div>
                  ) : (
                    supplyOrders.map((order) => (
                      <div className="row" key={order.id}>
                        <div className="col check">
                          <input type="checkbox" aria-label="Выбрать" />
                        </div>
                        <div className="col">
                          <div className="primary">{order.id}</div>
                          <div className="muted">{formatDate(order.createdAt)}</div>
                        </div>
                        <div className="col mono">{order.article || "—"}</div>
                        <div className="col mono">{order.nmId || "—"}</div>
                        <div className="col right">
                          <span className="pill">{timeAgo(order.createdAt)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {createOpen && (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Создать новую поставку</div>
                <div className="modal-subtitle">Быстрое добавление сборочных заданий</div>
              </div>
              <button className="icon-button" onClick={() => setCreateOpen(false)} type="button">
                {"\u00d7"}
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <label className="field">
                  <span>Название поставки</span>
                  <input
                    className="input"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="Например: Сборка утро 05.02"
                  />
                </label>
              </div>

              <div className="section">
                <div className="section-title">Товары из вкладки «Новые»</div>
                <div className="list items compact preview">
                  <div className="list-header">
                    <div className="col">Название</div>
                    <div className="col">Баркод</div>
                    <div className="col">Артикул продавца</div>
                    <div className="col">Артикул WB</div>
                    <div className="col right">Кол-во</div>
                  </div>
                  <div className="list-body">
                    {newItems.length === 0 ? (
                      <div className="empty">Нет новых товаров</div>
                    ) : (
                      newItems.map((item) => (
                        <div
                          className="row"
                          key={`${item.name || "—"}-${item.barcode || "—"}-${item.article || "—"}-${item.nmId || "—"}`}
                        >
                          <div className="col">
                            <div className="primary">{item.name || "—"}</div>
                          </div>
                          <div className="col mono">{item.barcode || "—"}</div>
                          <div className="col mono">{item.article || "—"}</div>
                          <div className="col mono">{item.nmId || "—"}</div>
                          <div className="col right">
                            <span className="count">{item.count}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="section">
                <div className="section-title">Режим создания</div>
                <div className="mode-toggle">
                  <button
                    type="button"
                    className={`chip ${createMode === "count" ? "active" : ""}`}
                    onClick={() => setCreateMode("count")}
                  >
                    По количеству
                  </button>
                  <button
                    type="button"
                    className={`chip ${createMode === "articles" ? "active" : ""}`}
                    onClick={() => setCreateMode("articles")}
                  >
                    По артикулам
                  </button>
                </div>
              </div>

              {createMode === "count" ? (
                <div className="form-grid">
                  <label className="field">
                    <span>Количество заказов</span>
                    <input
                      className="input"
                      type="number"
                      min="1"
                      value={createCount}
                      onChange={(e) => setCreateCount(e.target.value)}
                    />
                    <div className="chips">
                      {[10, 25, 50, 100, 200, 300].map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={`chip ${safeCreateCount === value ? "active" : ""}`}
                          onClick={() => setCreateCount(value)}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  </label>

                  <label className="field">
                    <span>Сортировка</span>
                    <select
                      className="input"
                      value={createSort}
                      onChange={(e) => setCreateSort(e.target.value)}
                    >
                      <option value="newest">Самые новые</option>
                      <option value="oldest">Самые старые</option>
                    </select>
                  </label>
                </div>
              ) : (
                <div className="section">
                  <div className="section-title">Выбор артикулов</div>
                  <div className="article-rows">
                    {articleRows.map((row) => {
                      const isDuplicate = row.article
                        ? articleRows.some((item) => item.id !== row.id && item.article === row.article)
                        : false;
                      const available =
                        row.article && articleSelection.availableByArticle.get(row.article)
                          ? articleSelection.availableByArticle.get(row.article)
                          : 0;
                      const max = Math.max(0, available || 0);
                      const isDisabled = max === 0;
                      return (
                        <div className="article-row" key={row.id}>
                          <label className="field">
                            <span>Артикул продавца</span>
                            <input
                              className={`input ${isDuplicate ? "input-error" : ""}`}
                              list="article-list"
                              value={row.article}
                              placeholder="Введите артикул"
                              onChange={(e) => {
                                const nextArticle = e.target.value.trim();
                                setArticleRows((rows) =>
                                  rows.map((item) =>
                                    item.id === row.id
                                      ? { ...item, article: nextArticle, count: nextArticle ? 1 : 0 }
                                      : item
                                  )
                                );
                              }}
                            />
                            {isDuplicate && (
                              <div className="hint small error">Артикул уже выбран в другой строке</div>
                            )}
                          </label>

                          <label className="field">
                            <span>Кол-во заказов</span>
                            <input
                              className="input"
                              type="number"
                              min={isDisabled ? 0 : 1}
                              max={max}
                              value={Math.min(row.count, max)}
                              onChange={(e) => {
                                const value = Number(e.target.value) || 0;
                                const next = Math.min(Math.max(value, isDisabled ? 0 : 1), max);
                                setArticleRows((rows) =>
                                  rows.map((item) =>
                                    item.id === row.id ? { ...item, count: next } : item
                                  )
                                );
                              }}
                              disabled={isDisabled}
                            />
                            <div className="hint small">Доступно: {available}</div>
                          </label>

                          <label className="field">
                            <span>Сортировка</span>
                            <select
                              className="input"
                              value={row.sortDir}
                              onChange={(e) =>
                                setArticleRows((rows) =>
                                  rows.map((item) =>
                                    item.id === row.id ? { ...item, sortDir: e.target.value } : item
                                  )
                                )
                              }
                            >
                              <option value="newest">Самые новые</option>
                              <option value="oldest">Самые старые</option>
                            </select>
                          </label>

                          <button
                            className="ghost-button small"
                            type="button"
                            onClick={() =>
                              setArticleRows((rows) => rows.filter((item) => item.id !== row.id))
                            }
                            disabled={articleRows.length === 1}
                          >
                            Удалить
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <datalist id="article-list">
                    {articleOptions.map((option) => (
                      <option key={option.article} value={option.article}>
                        {option.name ? `${option.article} — ${option.name}` : option.article}
                      </option>
                    ))}
                  </datalist>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() =>
                      setArticleRows((rows) => [
                        ...rows,
                        { id: rowIdRef.current++, article: "", count: 1, sortDir: "newest" },
                      ])
                    }
                  >
                    Добавить товар
                  </button>
                </div>
              )}

              <div className="preview">
                {createMode === "count" ? (
                  <>
                    <div className="preview-row">
                      <span>Запрошено</span>
                      <span>{requestedCount}</span>
                    </div>
                    <div className="preview-row">
                      <span>Будет выбрано</span>
                      <strong>{selection.selected.length}</strong>
                    </div>
                    <div className="preview-row">
                      <span>Доступно в группе</span>
                      <span>{selection.available}</span>
                    </div>
                    {selection.warehouseId != null && (
                      <div className="preview-row">
                        <span>Склад</span>
                        <span>{selection.warehouseId}</span>
                      </div>
                    )}
                    {selection.cargoType != null && (
                      <div className="preview-row">
                        <span>Тип габарита</span>
                        <span>{selection.cargoType}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="preview-row">
                      <span>Запрошено заказов</span>
                      <span>{articleRequested}</span>
                    </div>
                    <div className="preview-row">
                      <span>Будет выбрано</span>
                      <strong>{articleSelection.selected.length}</strong>
                    </div>
                    {articleSelection.warehouseId != null && (
                      <div className="preview-row">
                        <span>Склад</span>
                        <span>{articleSelection.warehouseId}</span>
                      </div>
                    )}
                    {articleSelection.cargoType != null && (
                      <div className="preview-row">
                        <span>Тип габарита</span>
                        <span>{articleSelection.cargoType}</span>
                      </div>
                    )}
                  </>
                )}
                {hasLimitWarning ? (
                  <div className="alert warn">
                    Запрошено {requestedCount}, доступно {selectedCount}. WB не принимает разные
                    склады/типы в одной поставке — отбор делается автоматически по первой заявке.
                  </div>
                ) : (
                  <div className="preview-note">
                    WB не принимает разные склады/типы в одной поставке — отбор делается
                    автоматически по первой заявке.
                  </div>
                )}
              </div>

              {createError && <div className="alert small">{createError}</div>}

              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setCreateOpen(false)} type="button">
                  Отмена
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleCreateSupply}
                  disabled={createBusy || !createName.trim() || !canCreate}
                >
                  {createBusy ? "Создаю…" : "Создать поставку"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editUser && (
        <div className="modal-backdrop" onClick={() => setEditUser(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Редактировать сотрудника</div>
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
export default App;






