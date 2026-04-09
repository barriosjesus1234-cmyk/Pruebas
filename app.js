(() => {
  'use strict';

  // =========================
  // Configuración base
  // =========================
  const CURRENCIES = ['CLP', 'VES', 'USD_BCV', 'USDT'];
  const STORAGE_KEY = 'currency_converter_rates_v1';
  const REQUEST_TIMEOUT_MS = 10000;

  // Claves de tasas primarias obligatorias
  // - VES por USDT (manual/cache)
  // - CLP por USDT (manual/cache)
  // - VES por USD_BCV (BCV/manual/cache)
  const RATE_KEYS = {
    VES_PER_USDT: 'VES_PER_USDT',
    CLP_PER_USDT: 'CLP_PER_USDT',
    VES_PER_USD_BCV: 'VES_PER_USD_BCV',
    USD_BCV_PER_USDT: 'USD_BCV_PER_USDT' // Derivada: VES_PER_USDT / VES_PER_USD_BCV
  };

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

      const requiredKeys = [
        RATE_KEYS.VES_PER_USDT,
        RATE_KEYS.CLP_PER_USDT,
        RATE_KEYS.VES_PER_USD_BCV
      ];

      return requiredKeys.every((key) => {
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
    function saveRates(ratesMap) {
      const payload = {
        savedAt: new Date().toISOString(),
        rates: ratesMap
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }

    function loadRates() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;

      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!parsed.rates || typeof parsed.rates !== 'object') return null;
        return parsed;
      } catch (error) {
        console.warn('No se pudo parsear cache de tasas:', error);
        return null;
      }
    }

    return {
      saveRates,
      loadRates
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
        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} al consultar ${url}`);
        }

        return response;
      } finally {
        clearTimeout(timer);
      }
    }

    async function fetchVesPerUsdBcv() {
      // Endpoint público BCV / referencia oficial intermedia
      // Puede fallar por CORS o disponibilidad; se resuelve con fallback a cache/manual.
      const url = 'https://ve.dolarapi.com/v1/dolares/oficial';
      const response = await fetchWithTimeout(url);
      const json = await response.json();

      const value = Number(json?.promedio || json?.valor || json?.price);
      if (!ValidationModule.isPositiveNumber(value)) {
        throw new Error('Respuesta inválida de BCV (VES por USD_BCV)');
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
        ...buildRateRow(
          usdBcvPerUsdt,
          'Derivada (VES/USDT ÷ VES/USD_BCV)',
          primaryRates[RATE_KEYS.VES_PER_USDT].status
        ),
        timestamp: new Date().toISOString()
      };

      return primaryRates;
    }

    async function fetchAllPrimaryRates() {
      const result = {};
      const errors = [];

      // Solo intentar BCV en esta versión.
      try {
        const value = await fetchVesPerUsdBcv();
        result[RATE_KEYS.VES_PER_USD_BCV] = buildRateRow(value, 'BCV', 'web');
      } catch (error) {
        errors.push({ key: RATE_KEYS.VES_PER_USD_BCV, error });
      }

      return { rates: result, errors };
    }

    function enrichWithCacheIfNeeded(webRates, cacheRates) {
      const merged = { ...webRates };
      const missingKeys = [RATE_KEYS.VES_PER_USDT, RATE_KEYS.CLP_PER_USDT, RATE_KEYS.VES_PER_USD_BCV].filter(
        (key) => !merged[key]
      );

      for (const key of missingKeys) {
        const cachedRow = cacheRates?.[key];
        if (cachedRow && ValidationModule.isPositiveNumber(Number(cachedRow.value))) {
          merged[key] = {
            ...cachedRow,
            status: 'cache',
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
      fetchAllPrimaryRates,
      computeDerivedRates,
      enrichWithCacheIfNeeded,
      buildFromManual
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

      return {
        amountUsdt,
        result
      };
    }

    return {
      convert
    };
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

      while (els.messages.children.length > 6) {
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
        const data = rates[row.key];

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
      toggleManualPanel
    };
  })();

  // =========================
  // App Controller
  // =========================
  const App = (() => {
    const state = {
      rates: null
    };

    function ensureDerivedAndValid(rates) {
      const primary = {
        [RATE_KEYS.VES_PER_USDT]: rates[RATE_KEYS.VES_PER_USDT],
        [RATE_KEYS.CLP_PER_USDT]: rates[RATE_KEYS.CLP_PER_USDT],
        [RATE_KEYS.VES_PER_USD_BCV]: rates[RATE_KEYS.VES_PER_USD_BCV]
      };

      if (!ValidationModule.isValidRatePayload(primary)) {
        return null;
      }

      return RatesModule.computeDerivedRates(primary);
    }

    async function loadRatesWithFallback() {
      UIModule.clearMessages();

      UIModule.showMessage(
        'warning',
        'Las tasas VES por USDT y CLP por USDT no se consultan automáticamente en esta versión. Se usarán valores guardados o tasas manuales.'
      );

      const cachePayload = StorageModule.loadRates();
      const cacheRates = cachePayload?.rates || null;

      let webRates = {};
      let webErrors = [];

      try {
        const fetched = await RatesModule.fetchAllPrimaryRates();
        webRates = fetched.rates;
        webErrors = fetched.errors;
      } catch (error) {
        webErrors = [{ key: 'unknown', error }];
      }

      for (const item of webErrors) {
        UIModule.showMessage('warning', `[${item.key}] ${ErrorModule.toUserMessage(item.error)}`);
      }

      const merged = RatesModule.enrichWithCacheIfNeeded(webRates, cacheRates);
      const finalRates = ensureDerivedAndValid(merged);

      if (finalRates) {
        state.rates = finalRates;
        StorageModule.saveRates(finalRates);

        const hasCacheRows = Object.values(finalRates).some((r) => r.status === 'cache');
        if (hasCacheRows) {
          UIModule.showMessage('warning', 'Se usaron una o más tasas desde cache por fallo de fuente web o ausencia de actualización automática.');
        } else {
          UIModule.showMessage('success', 'Tasas disponibles correctamente.');
        }

        UIModule.toggleManualPanel(false);
        UIModule.renderRates(state.rates);
        return;
      }

      UIModule.showMessage('error', 'No hay datos suficientes desde web/cache. Activa modo manual para continuar.');
      UIModule.toggleManualPanel(true);
      UIModule.renderRates(merged);
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
      const vesPerUsdt = Number(UIModule.els.manualVesUsdt.value);
      const clpPerUsdt = Number(UIModule.els.manualClpUsdt.value);
      const vesPerUsdBcv = Number(UIModule.els.manualVesUsdBcv.value);

      if (
        !ValidationModule.isPositiveNumber(vesPerUsdt) ||
        !ValidationModule.isPositiveNumber(clpPerUsdt) ||
        !ValidationModule.isPositiveNumber(vesPerUsdBcv)
      ) {
        UIModule.showMessage('error', 'En modo manual, todas las tasas deben ser números positivos.');
        return;
      }

      const manualRates = RatesModule.buildFromManual({ vesPerUsdt, clpPerUsdt, vesPerUsdBcv });
      state.rates = RatesModule.computeDerivedRates(manualRates);
      StorageModule.saveRates(state.rates);
      UIModule.renderRates(state.rates);
      UIModule.toggleManualPanel(false);
      UIModule.showMessage('success', 'Tasas manuales guardadas y activas.');
    }

    function bindEvents() {
      UIModule.els.convertBtn.addEventListener('click', convertCurrent);
      UIModule.els.swapBtn.addEventListener('click', swapCurrencies);
      UIModule.els.refreshRatesBtn.addEventListener('click', loadRatesWithFallback);
      UIModule.els.saveManualBtn.addEventListener('click', handleManualSave);

      UIModule.els.amount.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') convertCurrent();
      });
    }

    async function init() {
      UIModule.populateCurrencySelectors();
      bindEvents();
      await loadRatesWithFallback();
    }

    return {
      init
    };
  })();

  App.init();
})();
