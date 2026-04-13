(() => {
  'use strict';

  // =========================
  // Configuración base
  // =========================
  const CURRENCIES = ['CLP', 'VES', 'USD_BCV', 'USDT'];
  const STORAGE_KEY = 'currency_converter_rates_v1';
  const STORAGE_MANUAL_KEY = 'currency_converter_manual_rates_v1';
  const REQUEST_TIMEOUT_MS = 10000;

  // Claves de tasas primarias obligatorias
  // - VES por USDT (cache/manual por ahora)
  // - CLP por USDT (CoinGecko)
  // - VES por USD_BCV (BCV)
  const RATE_KEYS = {
    VES_PER_USDT: 'VES_PER_USDT',
    CLP_PER_USDT: 'CLP_PER_USDT',
    VES_PER_USD_BCV: 'VES_PER_USD_BCV',
    USD_BCV_PER_USDT: 'USD_BCV_PER_USDT' // Derivada: VES_PER_USDT / VES_PER_USD_BCV
  };

  const PRIMARY_KEYS = [RATE_KEYS.VES_PER_USDT, RATE_KEYS.CLP_PER_USDT, RATE_KEYS.VES_PER_USD_BCV];

  // =========================
  // Módulo de manejo de errores
  // =========================
  const ErrorModule = (() => {
    function toUserMessage(error) {
      const message = String(error?.message || error || 'Error desconocido');

      if (/abort|timeout/i.test(message)) {
        return 'Tiempo de espera agotado al consultar una fuente web. Se intentará fallback.';
      }

      if (/cors|failed to fetch|network/i.test(message)) {
        return 'No se pudo conectar con la fuente (red/CORS). Se intentará fallback automático.';
      }

      return `Ocurrió un problema: ${message}`;
    }

    return {
      toUserMessage
    };
  })();

  // =========================
  // Módulo de validación
  // =========================
  const ValidationModule = (() => {
    function isPositiveNumber(value) {
      return Number.isFinite(value) && value > 0;
    }

    function isValidRatePayload(ratePayload) {
      if (!ratePayload || typeof ratePayload !== 'object') return false;

      return PRIMARY_KEYS.every((key) => {
        const row = ratePayload[key];
        return row && isPositiveNumber(Number(row.value)) && typeof row.source === 'string' && row.source.length > 0;
      });
    }

    function validateAmount(rawAmount) {
      const amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount < 0) {
        return { ok: false, message: 'Ingresa un monto válido (número mayor o igual a 0).' };
      }
      return { ok: true, amount };
    }

    return {
      isPositiveNumber,
      isValidRatePayload,
      validateAmount
    };
  })();

  // =========================
  // Módulo de almacenamiento
  // =========================
  const StorageModule = (() => {
    function parseSafe(raw) {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (error) {
        console.warn('No se pudo parsear JSON en localStorage:', error);
        return null;
      }
    }

    function saveRates(ratesMap) {
      const payload = {
        savedAt: new Date().toISOString(),
        rates: ratesMap
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }

    function loadRates() {
      const parsed = parseSafe(localStorage.getItem(STORAGE_KEY));
      if (!parsed || typeof parsed !== 'object' || !parsed.rates || typeof parsed.rates !== 'object') {
        return null;
      }
      return parsed;
    }

    function saveManualRates(primaryManualRates) {
      const payload = {
        savedAt: new Date().toISOString(),
        rates: primaryManualRates
      };
      localStorage.setItem(STORAGE_MANUAL_KEY, JSON.stringify(payload));
    }

    function loadManualRates() {
      const parsed = parseSafe(localStorage.getItem(STORAGE_MANUAL_KEY));
      if (!parsed || typeof parsed !== 'object' || !parsed.rates || typeof parsed.rates !== 'object') {
        return null;
      }
      return parsed;
    }

    function clearManualRates() {
      localStorage.removeItem(STORAGE_MANUAL_KEY);
    }

    return {
      saveRates,
      loadRates,
      saveManualRates,
      loadManualRates,
      clearManualRates
    };
  })();

  // =========================
  // Módulo de tasas (fetch + cálculo)
  // =========================
  const RatesModule = (() => {
    async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} al consultar ${url}`);
        }
        return response;
      } finally {
        clearTimeout(timer);
      }
    }
async function fetchVesPerUsdtFromWorker() {
  const url = 'https://binance-ves-proxy.barriosjesus1234.workers.dev';
  const response = await fetchWithTimeout(url);
  const json = await response.json();

  const value = Number(json?.value);

  if (!ValidationModule.isPositiveNumber(value)) {
    throw new Error('Respuesta inválida del proxy Binance P2P (VES por USDT).');
  }

  return value;
}
    async function fetchClpPerUsdtFromCoinGecko() {
      // Endpoint simple price para Tether en CLP.
      const url = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=clp';
      const response = await fetchWithTimeout(url);
      const json = await response.json();

      const value = Number(json?.tether?.clp);
      if (!ValidationModule.isPositiveNumber(value)) {
        throw new Error('Respuesta inválida de CoinGecko (CLP por USDT).');
      }

      return value;
    }

    async function fetchVesPerUsdBcv() {
      // Se conserva la fuente actual para VES por USD_BCV.
      const url = 'https://ve.dolarapi.com/v1/dolares/oficial';
      const response = await fetchWithTimeout(url);
      const json = await response.json();

      const value = Number(json?.promedio || json?.valor || json?.price);
      if (!ValidationModule.isPositiveNumber(value)) {
        throw new Error('Respuesta inválida de BCV (VES por USD_BCV).');
      }

      return value;
    }

    function buildRateRow(value, source, status) {
      return {
        value,
        source,
        status,
        timestamp: new Date().toISOString()
      };
    }

    function computeDerivedRates(primaryRates) {
      const vesPerUsdt = Number(primaryRates[RATE_KEYS.VES_PER_USDT].value);
      const vesPerUsdBcv = Number(primaryRates[RATE_KEYS.VES_PER_USD_BCV].value);
      const usdBcvPerUsdt = vesPerUsdt / vesPerUsdBcv;

      primaryRates[RATE_KEYS.USD_BCV_PER_USDT] = {
        ...buildRateRow(usdBcvPerUsdt, 'Derivada (VES/USDT ÷ VES/USD_BCV)', primaryRates[RATE_KEYS.VES_PER_USDT].status),
        timestamp: new Date().toISOString()
      };

      return primaryRates;
    }

   async function fetchAvailableWebRates() {
  const result = {};
  const errors = [];

  // 🔥 VES/USDT desde Binance P2P (tu worker)
  try {
    const value = await fetchVesPerUsdtFromWorker();
    result[RATE_KEYS.VES_PER_USDT] = buildRateRow(
      value,
      'Binance P2P (promedio top 5)',
      'web'
    );
  } catch (error) {
    errors.push({ key: RATE_KEYS.VES_PER_USDT, error });
  }

  // CLP/USDT desde CoinGecko
  try {
    const value = await fetchClpPerUsdtFromCoinGecko();
    result[RATE_KEYS.CLP_PER_USDT] = buildRateRow(value, 'CoinGecko', 'web');
  } catch (error) {
    errors.push({ key: RATE_KEYS.CLP_PER_USDT, error });
  }

  // VES/USD_BCV desde BCV
  try {
    const value = await fetchVesPerUsdBcv();
    result[RATE_KEYS.VES_PER_USD_BCV] = buildRateRow(value, 'BCV', 'web');
  } catch (error) {
    errors.push({ key: RATE_KEYS.VES_PER_USD_BCV, error });
  }

  return { rates: result, errors };
}
    function fillMissingFromSource(baseRates, fallbackRates, newStatus) {
      const merged = { ...baseRates };

      for (const key of PRIMARY_KEYS) {
        if (merged[key]) continue;

        const row = fallbackRates?.[key];
        if (row && ValidationModule.isPositiveNumber(Number(row.value))) {
          merged[key] = {
            ...row,
            status: newStatus,
            timestamp: new Date().toISOString()
          };
        }
      }

      return merged;
    }

    function buildFromManual(manualValues) {
      const { vesPerUsdt, clpPerUsdt, vesPerUsdBcv } = manualValues;
      return {
        [RATE_KEYS.VES_PER_USDT]: buildRateRow(vesPerUsdt, 'Manual', 'manual'),
        [RATE_KEYS.CLP_PER_USDT]: buildRateRow(clpPerUsdt, 'Manual', 'manual'),
        [RATE_KEYS.VES_PER_USD_BCV]: buildRateRow(vesPerUsdBcv, 'Manual', 'manual')
      };
    }

    return {
      fetchAvailableWebRates,
      computeDerivedRates,
      fillMissingFromSource,
      buildFromManual,
      buildRateRow
    };
  })();

  // =========================
  // Módulo de conversión
  // =========================
  const ConversionModule = (() => {
    function toUsdt(amount, fromCurrency, rates) {
      if (fromCurrency === 'USDT') return amount;
      if (fromCurrency === 'VES') return amount / Number(rates[RATE_KEYS.VES_PER_USDT].value);
      if (fromCurrency === 'CLP') return amount / Number(rates[RATE_KEYS.CLP_PER_USDT].value);
      if (fromCurrency === 'USD_BCV') return amount / Number(rates[RATE_KEYS.USD_BCV_PER_USDT].value);
      throw new Error(`Moneda origen no soportada: ${fromCurrency}`);
    }

    function fromUsdt(amountUsdt, toCurrency, rates) {
      if (toCurrency === 'USDT') return amountUsdt;
      if (toCurrency === 'VES') return amountUsdt * Number(rates[RATE_KEYS.VES_PER_USDT].value);
      if (toCurrency === 'CLP') return amountUsdt * Number(rates[RATE_KEYS.CLP_PER_USDT].value);
      if (toCurrency === 'USD_BCV') return amountUsdt * Number(rates[RATE_KEYS.USD_BCV_PER_USDT].value);
      throw new Error(`Moneda destino no soportada: ${toCurrency}`);
    }

    function convert(amount, fromCurrency, toCurrency, rates) {
      const amountUsdt = toUsdt(amount, fromCurrency, rates);
      const result = fromUsdt(amountUsdt, toCurrency, rates);
      return { amountUsdt, result };
    }

    return { convert };
  })();

  // =========================
  // Módulo UI
  // =========================
  const UIModule = (() => {
    const els = {
      amount: document.getElementById('amount'),
      fromCurrency: document.getElementById('fromCurrency'),
      toCurrency: document.getElementById('toCurrency'),
      convertBtn: document.getElementById('convertBtn'),
      swapBtn: document.getElementById('swapBtn'),
      refreshRatesBtn: document.getElementById('refreshRatesBtn'),
      modifyManualBtn: document.getElementById('modifyManualBtn'),
      resetManualBtn: document.getElementById('resetManualBtn'),
      resultValue: document.getElementById('resultValue'),
      calcDetail: document.getElementById('calcDetail'),
      messages: document.getElementById('messages'),
      ratesTableBody: document.getElementById('ratesTableBody'),
      manualPanel: document.getElementById('manualPanel'),
      manualVesUsdt: document.getElementById('manualVesUsdt'),
      manualClpUsdt: document.getElementById('manualClpUsdt'),
      manualVesUsdBcv: document.getElementById('manualVesUsdBcv'),
      saveManualBtn: document.getElementById('saveManualBtn')
    };

    function populateCurrencySelectors() {
      for (const currency of CURRENCIES) {
        const optionA = document.createElement('option');
        optionA.value = currency;
        optionA.textContent = currency;

        const optionB = optionA.cloneNode(true);

        els.fromCurrency.appendChild(optionA);
        els.toCurrency.appendChild(optionB);
      }

      els.fromCurrency.value = 'USDT';
      els.toCurrency.value = 'VES';
    }

    function showMessage(type, text) {
      const div = document.createElement('div');
      div.className = `message ${type}`;
      div.textContent = text;
      els.messages.prepend(div);

      while (els.messages.children.length > 7) {
        els.messages.removeChild(els.messages.lastChild);
      }
    }

    function clearMessages() {
      els.messages.innerHTML = '';
    }

    function renderRates(rates) {
      const rows = [
        { label: 'VES por USDT', key: RATE_KEYS.VES_PER_USDT },
        { label: 'CLP por USDT', key: RATE_KEYS.CLP_PER_USDT },
        { label: 'VES por USD_BCV', key: RATE_KEYS.VES_PER_USD_BCV },
        { label: 'USD_BCV por USDT (derivada)', key: RATE_KEYS.USD_BCV_PER_USDT }
      ];

      els.ratesTableBody.innerHTML = '';

      for (const row of rows) {
        const data = rates?.[row.key];
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${row.label}</td>
          <td>${data ? formatNumber(data.value, 8) : '—'}</td>
          <td>${data?.source || '—'}</td>
          <td>${data?.timestamp ? new Date(data.timestamp).toLocaleString() : '—'}</td>
          <td>${data?.status || '—'}</td>
        `;
        els.ratesTableBody.appendChild(tr);
      }
    }

    function showResult(amount, from, result, to, amountUsdt) {
      els.resultValue.textContent = `${formatNumber(result, 8)} ${to}`;
      els.calcDetail.innerHTML = [
        `<strong>Paso 1:</strong> ${formatNumber(amount, 8)} ${from} → ${formatNumber(amountUsdt, 8)} USDT`,
        `<strong>Paso 2:</strong> ${formatNumber(amountUsdt, 8)} USDT → ${formatNumber(result, 8)} ${to}`
      ].join('<br/>');
    }

    function resetResult() {
      els.resultValue.textContent = '—';
      els.calcDetail.textContent = 'Sin cálculo aún.';
    }

    function toggleManualPanel(show) {
      els.manualPanel.classList.toggle('hidden', !show);
    }

    function setManualInputs(primaryRates) {
      els.manualVesUsdt.value = primaryRates?.[RATE_KEYS.VES_PER_USDT]?.value ?? '';
      els.manualClpUsdt.value = primaryRates?.[RATE_KEYS.CLP_PER_USDT]?.value ?? '';
      els.manualVesUsdBcv.value = primaryRates?.[RATE_KEYS.VES_PER_USD_BCV]?.value ?? '';
    }

    function readManualInputs() {
      return {
        vesPerUsdt: Number(els.manualVesUsdt.value),
        clpPerUsdt: Number(els.manualClpUsdt.value),
        vesPerUsdBcv: Number(els.manualVesUsdBcv.value)
      };
    }

    function formatNumber(value, maxDecimals = 6) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return '—';
      return new Intl.NumberFormat('es-CL', {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDecimals
      }).format(numeric);
    }

    return {
      els,
      populateCurrencySelectors,
      showMessage,
      clearMessages,
      renderRates,
      showResult,
      resetResult,
      toggleManualPanel,
      setManualInputs,
      readManualInputs
    };
  })();

  // =========================
  // App Controller
  // =========================
  const App = (() => {
    const state = {
      rates: null
    };

    function getPrimaryFromRates(rates) {
      if (!rates) return null;
      const primary = {
        [RATE_KEYS.VES_PER_USDT]: rates[RATE_KEYS.VES_PER_USDT],
        [RATE_KEYS.CLP_PER_USDT]: rates[RATE_KEYS.CLP_PER_USDT],
        [RATE_KEYS.VES_PER_USD_BCV]: rates[RATE_KEYS.VES_PER_USD_BCV]
      };
      return primary;
    }

    function ensureDerivedAndValid(rates) {
      const primary = getPrimaryFromRates(rates);
      if (!ValidationModule.isValidRatePayload(primary)) {
        return null;
      }
      return RatesModule.computeDerivedRates(primary);
    }

    function hasAnyManualPrimarySaved() {
      const manualPayload = StorageModule.loadManualRates();
      return Boolean(manualPayload?.rates);
    }

    function useManualPanelWithPrefill(basePrimaryRates = null) {
      UIModule.toggleManualPanel(true);

      if (basePrimaryRates) {
        UIModule.setManualInputs(basePrimaryRates);
        return;
      }

      const manualSaved = StorageModule.loadManualRates()?.rates;
      const fromState = getPrimaryFromRates(state.rates);
      UIModule.setManualInputs(manualSaved || fromState || null);
    }

    async function loadRatesWithFallback(options = {}) {
      const { keepMessages = false, prefillManualOnFailure = true } = options;
      if (!keepMessages) UIModule.clearMessages();

      UIModule.showMessage(
        'warning',
        'VES por USDT se mantiene por ahora desde valores guardados (cache) o manuales; no se consulta API para esa tasa.'
      );

      const cachePayload = StorageModule.loadRates();
      const cacheRates = cachePayload?.rates || null;
      const manualPayload = StorageModule.loadManualRates();
      const manualRates = manualPayload?.rates || null;

      let webRates = {};
      let webErrors = [];

      try {
        const fetched = await RatesModule.fetchAvailableWebRates();
        webRates = fetched.rates;
        webErrors = fetched.errors;
      } catch (error) {
        webErrors = [{ key: 'unknown', error }];
      }

      for (const item of webErrors) {
        UIModule.showMessage('warning', `[${item.key}] ${ErrorModule.toUserMessage(item.error)}`);
      }

      // Orden de fallback: web -> cache -> manual guardado
      let merged = RatesModule.fillMissingFromSource(webRates, cacheRates, 'cache');
      merged = RatesModule.fillMissingFromSource(merged, manualRates, 'manual');

      const finalRates = ensureDerivedAndValid(merged);
      if (finalRates) {
        state.rates = finalRates;
        StorageModule.saveRates(finalRates);

        const hasCacheRows = PRIMARY_KEYS.some((key) => finalRates[key]?.status === 'cache');
        const hasManualRows = PRIMARY_KEYS.some((key) => finalRates[key]?.status === 'manual');

        if (hasManualRows) {
          UIModule.showMessage('warning', 'Se usaron tasas manuales para completar datos faltantes.');
        } else if (hasCacheRows) {
          UIModule.showMessage('warning', 'Se usaron una o más tasas desde cache por fallo de fuente web.');
        } else {
          UIModule.showMessage('success', 'Tasas actualizadas desde web correctamente.');
        }

        UIModule.toggleManualPanel(false);
        UIModule.renderRates(state.rates);
        return;
      }

      UIModule.showMessage('error', 'No hay datos suficientes desde web/cache/manual guardado. Usa modo manual.');
      UIModule.renderRates(merged);

      if (prefillManualOnFailure) {
        useManualPanelWithPrefill(merged);
      } else {
        UIModule.toggleManualPanel(true);
        UIModule.setManualInputs(null);
      }
    }

    function convertCurrent() {
      if (!state.rates) {
        UIModule.showMessage('error', 'No hay tasas disponibles. Actualiza tasas o usa modo manual.');
        return;
      }

      const amountValidation = ValidationModule.validateAmount(UIModule.els.amount.value);
      if (!amountValidation.ok) {
        UIModule.showMessage('error', amountValidation.message);
        UIModule.resetResult();
        return;
      }

      const amount = amountValidation.amount;
      const from = UIModule.els.fromCurrency.value;
      const to = UIModule.els.toCurrency.value;

      try {
        const { amountUsdt, result } = ConversionModule.convert(amount, from, to, state.rates);
        UIModule.showResult(amount, from, result, to, amountUsdt);
        UIModule.showMessage('success', 'Conversión realizada correctamente.');
      } catch (error) {
        UIModule.showMessage('error', ErrorModule.toUserMessage(error));
      }
    }

    function swapCurrencies() {
      const from = UIModule.els.fromCurrency.value;
      UIModule.els.fromCurrency.value = UIModule.els.toCurrency.value;
      UIModule.els.toCurrency.value = from;
    }

    function handleManualSave() {
      const values = UIModule.readManualInputs();

      if (
        !ValidationModule.isPositiveNumber(values.vesPerUsdt) ||
        !ValidationModule.isPositiveNumber(values.clpPerUsdt) ||
        !ValidationModule.isPositiveNumber(values.vesPerUsdBcv)
      ) {
        UIModule.showMessage('error', 'En modo manual, todas las tasas deben ser números positivos.');
        return;
      }

      const manualPrimary = RatesModule.buildFromManual(values);
      StorageModule.saveManualRates(manualPrimary);

      state.rates = RatesModule.computeDerivedRates({ ...manualPrimary });
      StorageModule.saveRates(state.rates);
      UIModule.renderRates(state.rates);
      UIModule.toggleManualPanel(false);
      UIModule.showMessage('success', 'Tasas manuales guardadas y activas.');
    }

    function handleModifyManual() {
      const manualSaved = StorageModule.loadManualRates()?.rates;
      const primaryFromState = getPrimaryFromRates(state.rates);
      const hasManualActive = PRIMARY_KEYS.some((key) => state.rates?.[key]?.status === 'manual');

      if (hasManualActive || manualSaved) {
        useManualPanelWithPrefill(primaryFromState || manualSaved);
      } else {
        // Mantiene comportamiento útil aunque no haya manual previo.
        useManualPanelWithPrefill(primaryFromState);
      }

      UIModule.showMessage('success', 'Panel manual listo para modificar tasas.');
    }

    async function handleResetManual() {
      StorageModule.clearManualRates();
      UIModule.showMessage('warning', 'Tasas manuales guardadas eliminadas. Reintentando carga web/cache...');
      await loadRatesWithFallback({ keepMessages: true, prefillManualOnFailure: false });
    }

    function bindEvents() {
      UIModule.els.convertBtn.addEventListener('click', convertCurrent);
      UIModule.els.swapBtn.addEventListener('click', swapCurrencies);
      UIModule.els.refreshRatesBtn.addEventListener('click', () => loadRatesWithFallback());
      UIModule.els.saveManualBtn.addEventListener('click', handleManualSave);
      UIModule.els.modifyManualBtn.addEventListener('click', handleModifyManual);
      UIModule.els.resetManualBtn.addEventListener('click', handleResetManual);

      UIModule.els.amount.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') convertCurrent();
      });
    }

    async function init() {
      UIModule.populateCurrencySelectors();
      bindEvents();

      // Si ya hay manual guardado, se mantiene disponible para edición inmediata.
      if (hasAnyManualPrimarySaved()) {
        UIModule.showMessage('warning', 'Hay tasas manuales guardadas. Puedes editarlas con “Modificar tasas manuales”.');
      }

      await loadRatesWithFallback({ keepMessages: true });
    }

    return { init };
  })();

  App.init();
})();
