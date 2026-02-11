export default function EmployeeView({
  currentUser,
  handleLogout,
  employeeSuppliesError,
  employeeSuppliesLoading,
  employeeSupplies,
  employeeSelectedSupply,
  setEmployeeSelectedSupply,
  employeeSelectedOrder,
  setEmployeeSelectedOrder,
  employeeSelectedItem,
  setEmployeeSelectedItem,
  employeeOrders,
  employeeOrdersLoading,
  employeeOrdersError,
  employeeItems,
  employeeItemsLoading,
  employeeItemsError,
  labelScanInputRef,
  labelScanValue,
  setLabelScanValue,
  labelOpened,
  labelScanBusy,
  labelScanError,
  scanInputRef,
  scanValue,
  setScanValue,
  scanBusy,
  scanError,
  handleCollectOrder,
  employeeCollectError,
  formatDate,
  timeAgo,
}) {
  const orderIndex =
    employeeSelectedOrder && employeeOrders.length
      ? employeeOrders.findIndex((order) => order.id === employeeSelectedOrder.id)
      : -1;
  const nextOrder = orderIndex >= 0 ? employeeOrders[orderIndex + 1] : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="dot" />
          <div>
            <div className="title">WB Склад</div>
            <div className="subtitle">Личный кабинет сотрудника</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="user-chip">
            <div className="user-name">{currentUser.surname} {currentUser.name}</div>
            <div className="user-role">Сотрудник</div>
          </div>
          <button className="ghost-button small" type="button" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>
      {employeeSuppliesError && <div className="alert">{employeeSuppliesError}</div>}
      <section className="card">
        <div className="section-header">
          <div className="section-title">Мои поставки</div>
          <div className="hint">Выбирайте поставку, чтобы начать сборку.</div>
        </div>
        <div className="list supplies">
          <div className="list-header">
            <div className="col check" />
            <div className="col">Поставка</div>
            <div className="col">ID</div>
            <div className="col right">Осталось</div>
          </div>
          <div className="list-body">
            {employeeSuppliesLoading ? (
              <div className="empty">Загрузка…</div>
            ) : employeeSupplies.length === 0 ? (
              <div className="empty">Нет активных поставок</div>
            ) : (
              employeeSupplies.map((supply) => (
                <button
                  className="row row-button"
                  key={supply.id}
                  type="button"
                  onClick={() => setEmployeeSelectedSupply(supply)}
                >
                  <div className="col check">
                    <input type="checkbox" aria-label="Выбрать" onClick={(e) => e.stopPropagation()} />
                  </div>
                  <div className="col">
                    <div className="primary">{supply.name || `Поставка ${supply.id}`}</div>
                    <div className="muted">
                      {supply.storeName ? `Магазин: ${supply.storeName} \u00b7 ` : ""}
                      Доступ: {supply.accessMode === "all" ? "всем" : "назначено"}
                    </div>
                  </div>
                  <div className="col mono">{supply.id}</div>
                  <div className="col right">
                    <span className="count">{supply.remaining}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </section>

      {employeeSelectedSupply && (
        <div className="modal-backdrop" onClick={() => setEmployeeSelectedSupply(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">
                  Поставка {employeeSelectedSupply.id}
                  {employeeSelectedSupply.storeName ? ` \u00b7 ${employeeSelectedSupply.storeName}` : ""}
                </div>
                <div className="modal-subtitle">
                  {employeeSelectedOrder
                    ? "Информация о заказе"
                    : employeeSelectedItem
                    ? "Заказы по выбранному товару"
                    : "Товары в поставке"}
                </div>
              </div>
              <div className="modal-actions-inline">
                {employeeSelectedItem && !employeeSelectedOrder && (
                  <button
                    className="ghost-button small"
                    type="button"
                    onClick={() => setEmployeeSelectedItem(null)}
                  >
                    Назад
                  </button>
                )}
                {employeeSelectedOrder && (
                  <button
                    className="ghost-button small"
                    type="button"
                    onClick={() => setEmployeeSelectedOrder(null)}
                  >
                    К списку
                  </button>
                )}
                <button className="icon-button" onClick={() => setEmployeeSelectedSupply(null)} type="button">
                  {"\u00d7"}
                </button>
              </div>
            </div>

            <div className="modal-body">
              {employeeSelectedOrder ? (
                <div className="order-detail">
                  <div className="detail-row">
                    <span>Номер заказа</span>
                    <strong>{employeeSelectedOrder.id}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Магазин</span>
                    <strong>{employeeSelectedSupply?.storeName || "—"}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Дата и время</span>
                    <strong>
                      {employeeSelectedOrder.createdAt
                        ? new Date(employeeSelectedOrder.createdAt).toLocaleString("ru-RU")
                        : "—"}
                    </strong>
                  </div>
                  <div className="detail-row">
                    <span>Название</span>
                    <strong>{employeeSelectedOrder.productName || "—"}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Баркод</span>
                    <strong className="mono">{employeeSelectedOrder.barcode || "—"}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Артикул продавца</span>
                    <strong className="mono">{employeeSelectedOrder.article || "—"}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Артикул WB</span>
                    <strong className="mono">{employeeSelectedOrder.nmId || "—"}</strong>
                  </div>
                  <div className="detail-row">
                    <span>Количество</span>
                    <strong>{employeeSelectedOrder.quantity || 1}</strong>
                  </div>
                  {employeeSelectedOrder.scanPassed ? (
                    <>
                      <div className="scan-status success">Безошибочная сборка пройдена</div>
                      {employeeSelectedOrder.labelScanPassed ? (
                        <div className="scan-status success">Этикетка подтверждена</div>
                      ) : (
                        <div className="scan-block">
                          <div className="field">
                            <span>Штрихкод этикетки</span>
                            <input
                              ref={labelScanInputRef}
                              className="input"
                              value={labelScanValue}
                              onChange={(e) => setLabelScanValue(e.target.value)}
                              placeholder="Отсканируйте этикетку"
                              disabled={!labelOpened || labelScanBusy}
                            />
                          </div>
                          {!labelOpened && (
                            <div className="hint small">Сначала откройте этикетку</div>
                          )}
                          {labelScanError && <div className="alert small">{labelScanError}</div>}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="scan-block">
                      <div className="field">
                        <span>Штрихкод товара</span>
                        <input
                          ref={scanInputRef}
                          className="input"
                          value={scanValue}
                          onChange={(e) => setScanValue(e.target.value)}
                          placeholder="Отсканируйте штрихкод"
                          disabled={scanBusy}
                        />
                      </div>
                      {scanError && <div className="alert small">{scanError}</div>}
                    </div>
                  )}
                  <div className="detail-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => handleCollectOrder(employeeSelectedOrder)}
                      disabled={!employeeSelectedOrder.stickerUrl || !employeeSelectedOrder.scanPassed}
                    >
                      {employeeSelectedOrder.stickerUrl ? "Открыть этикетку" : "Этикетка не загружена"}
                    </button>
                    {nextOrder && (
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => setEmployeeSelectedOrder(nextOrder)}
                      >
                        Далее
                      </button>
                    )}
                  </div>
                  {employeeCollectError && <div className="alert small">{employeeCollectError}</div>}
                </div>
              ) : employeeSelectedItem ? (
                employeeOrdersLoading ? (
                  <div className="empty">Загрузка заказов…</div>
                ) : employeeOrdersError ? (
                  <div className="empty error">{employeeOrdersError}</div>
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
                      {employeeOrders.length === 0 ? (
                        <div className="empty">Нет заказов по этому товару</div>
                      ) : (
                        employeeOrders.map((order) => (
                          <button
                            className="row row-button"
                            key={order.id}
                            type="button"
                            onClick={() => setEmployeeSelectedOrder(order)}
                          >
                            <div className="col check">
                              <input type="checkbox" aria-label="Выбрать" onClick={(e) => e.stopPropagation()} />
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
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )
              ) : employeeItemsLoading ? (
                <div className="empty">Загрузка товаров…</div>
              ) : employeeItemsError ? (
                <div className="empty error">{employeeItemsError}</div>
              ) : (
                <div className="list items compact">
                  <div className="list-header">
                    <div className="col">Название</div>
                    <div className="col">Баркод</div>
                    <div className="col">Артикул продавца</div>
                    <div className="col">Артикул WB</div>
                    <div className="col right">Кол-во</div>
                  </div>
                  <div className="list-body">
                    {employeeItems.length === 0 ? (
                      <div className="empty">Нет товаров в этой поставке</div>
                    ) : (
                      employeeItems.map((item) => (
                        <button
                          className="row row-button"
                          key={`${item.productName || "—"}-${item.barcode || "—"}-${item.article || "—"}-${item.nmId || "—"}`}
                          type="button"
                          onClick={() => setEmployeeSelectedItem(item)}
                        >
                          <div className="col">
                            <div className="primary">{item.productName || "—"}</div>
                          </div>
                          <div className="col mono">{item.barcode || "—"}</div>
                          <div className="col mono">{item.article || "—"}</div>
                          <div className="col mono">{item.nmId || "—"}</div>
                          <div className="col right">
                            <span className="count">{item.count}</span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
