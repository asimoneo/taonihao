// ==UserScript==
// @name         Taobao / Tmall — умный поиск (RU/EN→中文) + цены ¥ → ₽
// @namespace    https://tampermonkey.net/
// @license      MIT
// @version      2.4.0
// @description  Цены ¥→₽ в реальном времени (курс: Rapira USDT/RUB ÷ USDT/CNY из P2P/форекса), собственный перевод страницы через Google (вкл/выкл, работает при догрузке), перевод поисковых запросов RU/EN→中文, перевод текста прямо на картинках (PaddleOCR/Tesseract в браузере без ключей или Google Cloud Vision).
// @match        *://*.taobao.com/*
// @match        *://*.tmall.com/*
// @run-at       document-start
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      translate.googleapis.com
// @connect      api.rapira.net
// @connect      p2p.binance.com
// @connect      www.okx.com
// @connect      hq.sinajs.cn
// @connect      vision.googleapis.com
// @connect      alicdn.com
// @connect      tbcdn.cn
// @connect      taobaocdn.com
// @connect      cdn.jsdelivr.net
// @connect      fastly.jsdelivr.net
// @connect      unpkg.com
// ==/UserScript==
 
(function () {
  'use strict';
 
  /* ══════════════════════════════════════════════════════════════════════
   *  0. ЧИСТЫЕ ФУНКЦИИ (без DOM): запросы, цены, курсы, батчи перевода
   * ══════════════════════════════════════════════════════════════════════ */
  // <pure>
  const DEFAULT_RATE = 12.25;      // ручной курс ₽ за 1 ¥
  const DEFAULT_USDT_CNY = 7.15;   // запасное значение ¥ за 1 USDT, пока автоисточники недоступны
 
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
  const LETTER_RE = /\p{L}/u;
 
  // ── поисковый запрос ────────────────────────────────────────────────
  const STOP_WORDS = new Set([
    'и', 'с', 'со', 'в', 'во', 'на', 'для', 'из', 'по', 'от', 'к', 'у', 'а', 'о', 'об',
    'the', 'a', 'an', 'and', 'for', 'with', 'of', 'to', 'in', 'on', 'or', '+', '&'
  ]);
  const KEEP_LATIN = new Set([
    'rtx', 'gtx', 'rx', 'ryzen', 'xeon', 'ddr', 'nvme', 'hdmi', 'usb', 'rgb', 'led',
    'oled', 'amoled', 'ips', 'cpu', 'gpu', 'wifi', 'wi-fi', 'nfc', 'gps', 'lte', 'esim',
    'pro', 'max', 'plus', 'ultra'
  ]);
  const UNITS = {
    'ггц': 'GHz', 'мгц': 'MHz', 'гб': 'GB', 'тб': 'TB', 'мб': 'MB', 'гц': 'Hz',
    'мач': 'mAh', 'вт': 'W', 'мм': 'mm', 'см': 'cm', 'кг': 'kg', 'мп': 'MP'
  };
  // составные слова, где 的/和/与/带/有 — часть слова, а не союз
  const KEEP_COMPOUNDS = [
    '传送带', '安全带', '松紧带', '魔术带', '没有', '皮带', '领带', '背带', '磁带', '腰带', '胶带',
    '绷带', '丝带', '鞋带', '吊带', '肩带', '束带', '表带', '腕带', '头带', '发带', '织带',
    '绑带', '带子', '带扣', '带轮', '灯带', '所有', '拥有', '具有', '现有', '有机', '有线', '有限',
    '有源', '有声', '有色', '有氧', '有效', '有用', '和田', '和服', '和平', '柔和', '温和',
    '暖和', '缓和', '目的', '的确', '的士'
  ].sort((a, b) => b.length - a.length);
 
  function normalizeQuery(raw) {
    let s = String(raw).replace(/[\u00a0\u3000]/g, ' ');
    s = s.replace(/[,;，、；|()（）\[\]{}«»"“”]/g, ' ');
    s = s.replace(
      /(\d+(?:[.,]\d+)?)\s*(ггц|мгц|гб|тб|мб|гц|мач|вт|мм|см|кг|мп)(?![\p{L}])/giu,
      (_, n, u) => n.replace(',', '.') + UNITS[u.toLowerCase()]
    );
    s = s.replace(/(\d+)[кК](?![\p{L}\d])/gu, '$1K');
    return s.replace(/\s+/g, ' ').trim();
  }
 
  /** Токен нельзя переводить: модель, число, стандарт, аббревиатура, иероглифы. */
  function isProtected(tok) {
    if (CJK_RE.test(tok)) return true;
    if (!LETTER_RE.test(tok)) return true;
    if (KEEP_LATIN.has(tok.toLowerCase())) return true;
    if (/^[\x21-\x7e]+$/.test(tok)) {
      if (/\d/.test(tok)) return true;                                   // RTX5050, i7-13645HX, 180Hz, 4K
      if (/[-_/]/.test(tok.replace(/^[-_/]+|[-_/]+$/g, ''))) return true; // Type-C, Wi-Fi
      if (/^[A-Z]{2,}$/.test(tok)) return true;                          // LED, USB
      if (/^[a-z]+[A-Z]/.test(tok)) return true;                         // iPhone
    }
    return false;
  }
 
  /** Запрос → сегменты: keep (как есть) и пробеги слов для перевода (контекст внутри сохраняется). */
  function buildPlan(raw) {
    const norm = normalizeQuery(raw);
    const parts = [];
    for (const t of norm.split(' ')) {
      const tok = t.replace(/^[.:!?\-–—_/\\]+|[.:!?\-–—_/\\]+$/g, '');
      if (!tok || STOP_WORDS.has(tok.toLowerCase())) continue;
      if (isProtected(tok)) parts.push({ keep: true, text: tok });
      else {
        const last = parts[parts.length - 1];
        if (last && !last.keep) last.text += ' ' + tok;
        else parts.push({ keep: false, text: tok });
      }
    }
    return { norm, parts, runs: parts.filter((p) => !p.keep).length };
  }
 
  /** Китайский перевод → чистые теги: убрать 的/和/与/带/有/+ и пунктуацию. */
  function cleanZh(input) {
    let s = String(input);
    const masked = [];
    for (const w of KEEP_COMPOUNDS) {
      if (s.includes(w)) { s = s.split(w).join('\uE000' + masked.length + '\uE001'); masked.push(w); }
    }
    s = s.replace(/[的和与带有+＋&]/g, ' ');
    s = s.replace(/[，。、；：！？“”‘’《》「」『』（）()\[\]【】,;:!?"]/g, ' ');
    s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
    s = s.replace(/\uE000(\d+)\uE001/g, (_, i) => masked[+i]);
    return s.replace(/\s+/g, ' ').trim();
  }
 
  // ── цены ────────────────────────────────────────────────────────────
  // Цена целиком в одном узле: «¥158», «¥0.3», «约省¥0.68», «券后¥79.9», «¥79-¥120», «¥99起», «¥5.9/件»
  const PRICE_RE = /^([^\d¥￥]{0,80}?)\s*[¥￥]\s*(\d[\d,]*(?:\.\d+)?)(?:\s*[-~–—至]\s*[¥￥]?\s*(\d[\d,]*(?:\.\d+)?))?\s*(?:起售|起|\+|\/\s*[\p{L}.]{1,8})?\s*$/u;
  const NOSYM_RE = /^(\d[\d,]*(?:\.\d+)?)$/;
  // Числовая часть после отдельного символа ¥: «18.96», «4», «79-¥120»
  const NUM_PART_RE = /^(\d[\d,]*(?:\.\d+)?)(?:[-~–—至][¥￥]?(\d[\d,]*(?:\.\d+)?))?$/;
 
  const num = (s) => parseFloat(String(s).replace(/,/g, ''));
 
  function parsePrice(text, requireSym) {
    let m = PRICE_RE.exec(text);
    if (m) {
      const lo = num(m[2]);
      const hi = m[3] !== undefined ? num(m[3]) : null;
      if (isFinite(lo) && (hi === null || isFinite(hi)) && !(lo === 0 && hi === null)) {
        return { prefix: (m[1] || '').trim(), lo, hi };
      }
      return null;
    }
    if (requireSym) return null;
    m = NOSYM_RE.exec(text);
    if (m && num(m[1]) > 0) return { prefix: '', lo: num(m[1]), hi: null };
    return null;
  }
 
  /** Фрагмент текста соседнего узла может быть частью числа («18», «.96», «-», «¥»). */
  function isNumFrag(t) { return /^[\d.,\-~–—至¥￥]+$/.test(t); }
 
  /** Не склеиваем два отдельных числа («5» + «100» из соседнего блока продаж). */
  function canAppendFrag(acc, frag) {
    if (!acc) return /^\d/.test(frag);
    return !(/\d$/.test(acc) && /^\d/.test(frag));
  }
 
  function parseNumPart(s) {
    const m = NUM_PART_RE.exec(s);
    if (!m) return null;
    const lo = num(m[1]);
    const hi = m[2] !== undefined ? num(m[2]) : null;
    if (!isFinite(lo) || (hi !== null && !isFinite(hi)) || (lo === 0 && hi === null)) return null;
    return { prefix: '', lo, hi };
  }
 
  function formatRub(cny, rate) {
    const v = cny * rate;
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: v < 100 ? 1 : 0 }).format(v);
  }
 
  function sanitizeRate(x) {
    const n = parseFloat(String(x).replace(',', '.'));
    return isFinite(n) && n > 0 && n < 10000 ? Math.round(n * 10000) / 10000 : null;
  }
 
  // ── курсы ───────────────────────────────────────────────────────────
  function computeRate(auto, usdtRub, usdtCny, manual) {
    if (auto && usdtRub > 0 && usdtCny > 0) return Math.round((usdtRub / usdtCny) * 10000) / 10000;
    return manual;
  }
 
  function parseRapira(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
    const it = list.find((x) => x && x.symbol === 'USDT/RUB');
    if (!it) return null;
    const v = parseFloat(it.close !== undefined ? it.close : (it.last !== undefined ? it.last : it.lastPrice));
    return isFinite(v) && v > 20 && v < 1000 ? v : null;
  }
 
  const CNY_MIN = 5.5, CNY_MAX = 9;
  const okCny = (v) => isFinite(v) && v >= CNY_MIN && v <= CNY_MAX;
  const round4 = (v) => Math.round(v * 10000) / 10000;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
 
  function median(a) {
    const s = a.slice().sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
 
  function parseBinanceP2P(json) {
    const list = json && Array.isArray(json.data) ? json.data : [];
    return median(list.slice(0, 10).map((x) => parseFloat(x && x.adv && x.adv.price)).filter(okCny));
  }
 
  function parseOkxP2P(json) {
    const d = json && json.data;
    if (!d) return null;
    const side = (arr) => median((Array.isArray(arr) ? arr : []).slice(0, 10).map((x) => parseFloat(x && x.price)).filter(okCny));
    const m = [side(d.sell), side(d.buy)].filter((v) => v !== null);
    return m.length ? mean(m) : null;
  }
 
  function parseOkxFx(json) {
    const v = parseFloat(json && json.data && json.data[0] && json.data[0].usdCny);
    return okCny(v) ? v : null;
  }
 
  function parseSinaFx(text) {
    const m = /="([^"]*)"/.exec(String(text));
    if (!m) return null;
    const f = m[1].split(',');
    const v = [1, 2].map((i) => parseFloat(f[i])).filter(okCny);
    return v.length ? mean(v) : null;
  }
 
  /** Приоритет: P2P (реальный рынок USDT→CNY), затем форекс USD/CNY. */
  function pickUsdtCny(r) {
    const has = (x) => x[1] !== null && x[1] !== undefined;
    const p2p = [['Binance', r.binance], ['OKX', r.okxP2p]].filter(has);
    if (p2p.length) return { value: round4(mean(p2p.map((x) => x[1]))), kind: 'P2P', parts: p2p };
    const fx = [['OKX', r.okxFx], ['Sina', r.sina]].filter(has);
    if (fx.length) return { value: round4(mean(fx.map((x) => x[1]))), kind: 'FX', parts: fx };
    return null;
  }
 
 
  // ── словарь интерфейса Taobao/Tmall (машинный перевод тут ошибается: 宝贝 = «товар», а не «малыш») ──
  // Можно дополнять своими строками: 'китайский текст': 'перевод'.
  const UI_DICT = {
    // шапка, меню пользователя
    '淘宝网首页': 'Главная Taobao', '淘宝首页': 'Главная Taobao', '我的淘宝': 'Мой Taobao', '已买到的宝贝': 'Мои покупки',
    '已买到': 'Мои покупки', '我的足迹': 'История просмотров', '足迹': 'История просмотров', '我的卡券包': 'Мои купоны',
    '收藏的宝贝': 'Избранные товары', '收藏的店铺': 'Избранные магазины', '已卖出的宝贝': 'Проданные товары',
    '出售中的宝贝': 'Товары в продаже', '收藏夹': 'Избранное', '购物车': 'Корзина', '帮助中心': 'Справка',
    '意见反馈': 'Обратная связь', '反馈': 'Отзыв о сайте', '账号管理': 'Управление аккаунтом', '退出': 'Выйти',
    '查看你的专属权益': 'Ваши привилегии', '网页无障碍': 'Доступность', '中文(zh)': 'Китайский (zh)', '英文(en)': 'Английский (en)',
    '中国大陆': 'Материковый Китай', '免费开店': 'Открыть магазин', '淘宝开店': 'Магазин на Taobao', '天猫开店': 'Магазин на Tmall',
    '开直播店': 'Стрим-магазин', '千牛卖家中心': 'Центр продавца Qianniu', '商家中心': 'Центр продавца', '开店入驻': 'Стать продавцом',
    '卖家服务市场': 'Сервисы для продавцов', '卖家培训中心': 'Обучение продавцов', '体检中心': 'Проверка магазина',
    '电商学习中心': 'Обучение e-commerce', '商家客服': 'Поддержка продавцов', '消息中心': 'Сообщения', '举报中心': 'Жалобы',
    '淘宝规则': 'Правила Taobao', '天猫规则': 'Правила Tmall', '规则众议': 'Обсуждение правил', '商家支持': 'Поддержка продавцов',
    '商家入驻': 'Стать продавцом', '淘天标准': 'Стандарты Taobao/Tmall', '商家工具': 'Инструменты продавца',
    '商家学习中心': 'Обучение продавцов', '商家服务大厅': 'Сервисы для продавцов', '问商友': 'Спросить продавцов',
    '消费者客服': 'Поддержка покупателей', '卖家客服': 'Поддержка продавцов', '网页版旺旺': 'Чат Wangwang', '桌面版': 'Версия для ПК',
    '回顶部': 'Наверх', '全部频道': 'Все разделы', '分类': 'Категории', '天猫超市': 'Tmall Супермаркет', '天猫国际': 'Tmall International',
    '聚划算': 'Групповые скидки', '直播频道': 'Прямые эфиры', '飞猪旅行': 'Путешествия Fliggy', '淘宝客户端': 'Приложение Taobao',
    // поиск и фильтры
    '搜索': 'Найти', '搜本店': 'В магазине', '宝贝': 'Товары', '店铺': 'Магазины', '天猫': 'Tmall', '淘宝': 'Taobao',
    '按图片搜索': 'Поиск по фото', '上传图片': 'Загрузить фото', 'Ctrl+V 粘贴图片到此处': 'Ctrl+V — вставьте картинку сюда',
    'Ctrl+V 粘贴图片快速图搜': 'Ctrl+V — быстрый поиск по картинке', '搜同款': 'Найти такой же', '所有宝贝': 'Все товары',
    '企业购': 'Для бизнеса', '发货地': 'Откуда отправка', '综合': 'По релевантности', '销量': 'По продажам', '价格': 'Цена',
    '区间': 'Диапазон', '包邮': 'Бесплатная доставка', '退货宝': 'Страховка возврата', '淘金币抵钱': 'Оплата монетами Taobao',
    '筛选': 'Фильтры', '上一页': 'Назад', '下一页': 'Вперёд', '到第': 'Перейти на', '页': 'стр.', '确定': 'OK',
    '大家都在搜': 'Часто ищут',
    // метки в карточках
    '首单价': 'Цена 1-го заказа', '优惠后': 'После скидки', '券后': 'С купоном', '大促价保': 'Гарантия цены',
    '降价提醒': 'Сообщить о снижении цены', '不喜欢该商品': 'Не нравится товар', '您加购的商品降价了': 'Товар из корзины подешевел',
    '失效': 'Недействительно', '热销爆款': 'Хит продаж', '官方客服': 'Официальная поддержка', '品牌入口': 'Бренды',
    '天猫榜单': 'Рейтинги Tmall', '热卖频道': 'Хиты продаж', '超级88': 'Super 88', '国家补贴': 'Госсубсидия',
    '百亿补贴 · 买贵必赔': 'Субсидии · вернём разницу, если найдёте дешевле', '淘宝秒杀': 'Молниеносные скидки',
    '大牌试用': 'Пробники брендов', '猜你喜欢': 'Вам может понравиться', '更多低价商品': 'Ещё недорогие товары', '刷新': 'Обновить',
    '关注店铺': 'Подписаться на магазин', '热销推荐': 'Хиты продаж', '好评推荐': 'С лучшими отзывами', '近期热卖': 'Сейчас популярно',
    // блок пользователя на главной
    '登录淘宝后更多精彩': 'Войдите в Taobao, чтобы увидеть больше', '立即登录': 'Войти', '收货地址': 'Адреса доставки',
    '待付款': 'Ожидают оплаты', '待发货': 'Ожидают отправки', '待收货': 'В пути', '待评价': 'Ждут отзыва', '红包': 'Бонусы',
    '优惠券': 'Купоны', '张': 'шт.', '淘金币抵': 'Монеты Taobao', '买过的店': 'Мои магазины', '消息': 'Сообщения', '逛一逛': 'Обзор',
    // карточка товара
    '客服': 'Поддержка', '进店': 'В магазин', '视频': 'Видео', '图集': 'Фото', '参数': 'Характеристики', '用户评价': 'Отзывы',
    '参数信息': 'Характеристики', '图文详情': 'Описание', '本店推荐': 'Рекомендации магазина', '看了又看': 'С этим смотрят',
    '查看全部评价': 'Все отзывы', '匿名买家': 'Анонимный покупатель', '颜色分类': 'Вариант', '发光颜色': 'Цвет свечения',
    '尺码': 'Размер', '尺寸': 'Размер', '套餐类型': 'Комплектация', '平台加补后': 'С субсидией платформы', '优惠前': 'До скидки',
    '已享受:': 'Применено:', '可再享:': 'Ещё доступно:', '即时可用': 'Действует сразу',
    '首单礼金店铺新客专享': 'Бонус на первый заказ для новых покупателей', '可开发票': 'Можно выставить счёт',
    '假一赔四': 'Подделка — компенсация ×4', '极速退款': 'Быстрый возврат денег', '7天无理由退换': 'Возврат 7 дней без причины',
    '信用卡支付': 'Оплата кредитной картой', '切换大图模式': 'Крупные изображения', '数量': 'Количество', '有货': 'В наличии',
    '无货': 'Нет в наличии', '领券购买': 'Купить с купоном', '立即购买': 'Купить сейчас', '加入购物车': 'В корзину', '收藏': 'В избранное',
    '用户调研': 'Опрос', '商品码': 'Код товара', '扫一扫 在手机淘宝查看': 'Откройте в приложении Taobao', '更多': 'Ещё',
    '复制链接': 'Копировать ссылку', '举报': 'Пожаловаться', '问问': 'Спросить', '有什么想了解的，问我吧': 'Есть вопросы? Спросите меня',
    '联系客服': 'Написать продавцу', '旺旺在线': 'Продавец онлайн', '材质': 'Материал', '色温': 'Цветовая температура',
    '控制方式': 'Способ управления', '电压': 'Напряжение', '款式': 'Модель', '品牌': 'Бренд', '型号': 'Артикул',
    '控制类型': 'Тип управления', '计价单位': 'Единица', '蓝光危害等级': 'Класс опасности синего света', '安装方式': 'Монтаж',
    '明装': 'Накладной монтаж', '暖黄': 'Тёплый жёлтый', '中性光': 'Нейтральный свет', '暖光': 'Тёплый свет', '白光': 'Холодный белый',
    '已连接天猫精灵': 'Работает с Tmall Genie', '产地': 'Страна производства', '适用空间': 'Помещение', '功率': 'Мощность',
    '颜色': 'Цвет', '重量': 'Вес', '长度': 'Длина', '宽度': 'Ширина', '高度': 'Высота'
  };
 
  // Типовые строки с числами: «1000+人付款», «满11减8», «8年老店» …
  function cnNum(s) {
    return String(s).replace(/([\d.]+)([万千])/g, (_, n, u) =>
      Math.round(parseFloat(n) * (u === '万' ? 10000 : 1000)).toLocaleString('ru-RU'));
  }
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }
  const N = '([\\d.]+[万千]?\\+?)';
  const UI_PATTERNS = [
    [new RegExp('^' + N + '人付款$'), (m) => cnNum(m[1]) + ' оплатили'],
    [new RegExp('^' + N + '人(?:购买|已买)$'), (m) => cnNum(m[1]) + ' купили'],
    [new RegExp('^' + N + '人已抢$'), (m) => cnNum(m[1]) + ' уже купили'],
    [new RegExp('^' + N + '人(?:收藏|想要)$'), (m) => cnNum(m[1]) + ' в избранном'],
    [new RegExp('^超' + N + '人加购$'), (m) => 'Более ' + cnNum(m[1]) + ' добавили в корзину'],
    [new RegExp('^已售\\s*' + N + '$'), (m) => 'Продано ' + cnNum(m[1])],
    [new RegExp('^月销\\s*' + N + '$'), (m) => 'Продано за месяц ' + cnNum(m[1])],
    [/^(\d+)年老店$/, (m) => 'Магазину ' + m[1] + ' ' + plural(+m[1], 'год', 'года', 'лет')],
    [/^直降([\d.]+)元$/, (m) => 'Скидка ' + m[1] + ' ¥'],
    [/^已降([\d.]+)元$/, (m) => 'Подешевел на ' + m[1] + ' ¥'],
    [/^已补([\d.]+)元$/, (m) => 'Субсидия ' + m[1] + ' ¥'],
    [/^官方立减([\d.]+)%省([\d.]+)元$/, (m) => 'Скидка платформы ' + m[1] + '% (−' + m[2] + ' ¥)'],
    [/^官方立减([\d.]+)%$/, (m) => 'Скидка платформы ' + m[1] + '%'],
    [/^官方立减([\d.]+)元$/, (m) => 'Скидка платформы ' + m[1] + ' ¥'],
    [/^超级立减([\d.]+)%$/, (m) => 'Суперскидка ' + m[1] + '%'],
    [/^超级立减([\d.]+)元$/, (m) => 'Суперскидка ' + m[1] + ' ¥'],
    [/^券满([\d.]+)减([\d.]+)$/, (m) => 'Купон: −' + m[2] + ' ¥ от ' + m[1] + ' ¥'],
    [/^满([\d.]+)减([\d.]+)$/, (m) => '−' + m[2] + ' ¥ от ' + m[1] + ' ¥'],
    [/^满([\d.]+)元?打([\d.]+)折$/, (m) => 'Скидка ' + Math.round(100 - parseFloat(m[2]) * 10) + '% от ' + m[1] + ' ¥'],
    [/^淘金币(?:可)?抵([\d.]+)元起?$/, (m) => 'Монетами Taobao −' + m[1] + ' ¥'],
    [/^政府补贴([\d.]+%)$/, (m) => 'Госсубсидия ' + m[1]],
    [/^店铺新客减([\d.]+)元$/, (m) => 'Новым покупателям магазина −' + m[1] + ' ¥'],
    [/^(\d+)小时内发(?:货)?$/, (m) => 'Отправка в течение ' + m[1] + ' ч'],
    [/^(\d+)天内发(?:货)?$/, (m) => 'Отправка в течение ' + m[1] + ' ' + plural(+m[1], 'дня', 'дней', 'дней')],
    [/^回头客(\d+)人$/, (m) => 'Постоянных покупателей: ' + m[1]],
    [/^(\d+)天新增(\d+)条好评$/, (m) => '+' + m[2] + ' хороших отзывов за ' + m[1] + ' дн.'],
    [/^及时发货率([\d.]+%)$/, (m) => 'Своевременная отправка: ' + m[1]],
    [/^客服平均(\d+)秒回复$/, (m) => 'Поддержка отвечает в среднем за ' + m[1] + ' с'],
    [/^(\d+)元红包仅剩\s*(\d+)小时$/, (m) => 'Бонус ' + m[1] + ' ¥ · осталось ' + m[2] + ' ч'],
    [/^([\d.]+)折起$/, (m) => 'Скидки до ' + Math.round(100 - parseFloat(m[1]) * 10) + '%']
  ];
 
  /** Перевод без Google: словарь интерфейса и шаблоны. null — отдать машинному переводу. */
  function localTranslate(core) {
    if (Object.prototype.hasOwnProperty.call(UI_DICT, core)) return UI_DICT[core];
    for (const [re, fn] of UI_PATTERNS) { const m = re.exec(core); if (m) return fn(m); }
    return null;
  }
 
  // Сленг Taobao, который сбивает машинный перевод: заменяем на нейтральные слова перед отправкой в Google
  const SLANG = [['宝贝', '商品'], ['亲们', '顾客们'], ['亲', '您'], ['掌柜', '店主'], ['旺旺', '客服聊天'], ['淘金币', '淘宝金币'],
    ['包邮', '免运费'], ['拍下', '下单'], ['秒杀', '限时抢购']];
  function prepForGoogle(core) {
    let s = core;
    for (const [a, b] of SLANG) if (s.includes(a)) s = s.split(a).join(b);
    return s;
  }
 
  // ── перевод страницы: батчи для Google ──────────────────────────────
  /** Делит строки на батчи так, чтобы закодированный q не превышал maxEnc символов. */
  function buildBatches(list, maxEnc) {
    const out = [];
    let cur = [], len = 0;
    for (const s of list) {
      const l = encodeURIComponent(s).length + 3;
      if (cur.length && len + l > maxEnc) { out.push(cur); cur = []; len = 0; }
      cur.push(s); len += l;
    }
    if (cur.length) out.push(cur);
    return out;
  }
 
  function parseGtx(data) {
    return ((data && data[0]) || []).map((s) => s && s[0]).filter((x) => typeof x === 'string').join('');
  }
 
  /** Разбирает перевод батча обратно по строкам; null — если Google склеил/потерял строки. */
  function splitGtx(joined, n) {
    const parts = String(joined).split('\n').map((s) => s.trim());
    while (parts.length > n && parts[parts.length - 1] === '') parts.pop();
    return parts.length === n && parts.every(Boolean) ? parts : null;
  }
 
  // ── OCR картинки: разбор ответа Google Cloud Vision и геометрия ─────
  const OCR_MAX_BYTES = 7 * 1024 * 1024;     // лимит запроса Vision 10 МБ, base64 раздувает размер на треть
 
  function sniffMime(u8) {
    if (u8.length > 12) {
      if (u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
      if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
      if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
      if (u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
    }
    return null;
  }
 
  function bytesToBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
 
  /** Строки абзаца → одна фраза: разрядку «检 测 报 告» склеиваем, настоящие пробелы между словами оставляем, переносы → пробел. */
  function tidyOcrText(t) {
    const single = (x) => x.length === 1 && /[㐀-鿿＀-￯]/.test(x);
    return String(t).split('\n').map((line) => {
      const out = [];
      for (const tok of line.trim().split(/\s+/).filter(Boolean)) {
        const last = out[out.length - 1];
        if (last && last.run && single(tok)) last.s += tok; else out.push({ s: tok, run: single(tok) });
      }
      return out.map((o) => o.s).join(' ');
    }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
 
  /** Vision не присылает x/y, равные 0 — подставляем ноль. */
  function vertsOf(box) {
    const v = box && box.vertices;
    if (!Array.isArray(v) || v.length < 4) return null;
    return v.slice(0, 4).map((p) => ({ x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 }));
  }
 
  /** Ответ images:annotate (один элемент responses[]) → [{text, verts}] по абзацам. */
  function visionToBlocks(r) {
    const out = [];
    const pages = r && r.fullTextAnnotation && r.fullTextAnnotation.pages;
    if (pages && pages.length) {
      for (const pg of pages) for (const b of pg.blocks || []) for (const p of b.paragraphs || []) {
        let t = '';
        for (const w of p.words || []) for (const sym of w.symbols || []) {
          t += sym.text || '';
          const br = sym.property && sym.property.detectedBreak && sym.property.detectedBreak.type;
          if (br === 'SPACE' || br === 'SURE_SPACE') t += ' ';
          else if (br === 'EOL_SURE_SPACE' || br === 'LINE_BREAK') t += '\n';
        }
        const verts = vertsOf(p.boundingBox);
        if (verts) out.push({ text: tidyOcrText(t), verts });
      }
    } else {
      // запасной путь: textAnnotations[0] — весь текст, дальше отдельные фрагменты с рамками
      for (const a of ((r && r.textAnnotations) || []).slice(1)) {
        const verts = vertsOf(a.boundingPoly);
        if (verts) out.push({ text: tidyOcrText(a.description || ''), verts });
      }
    }
    return out.filter((b) => b.text);
  }
 
  /** Четырёхугольник текста → центр, размеры вдоль/поперёк строки и угол (градусы). */
  function quadInfo(v) {
    const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    let ang = Math.atan2(v[1].y - v[0].y, v[1].x - v[0].x) * 180 / Math.PI;
    if (Math.abs(ang) < 2 || Math.abs(ang) > 90) ang = 0;
    return {
      cx: (v[0].x + v[1].x + v[2].x + v[3].x) / 4,
      cy: (v[0].y + v[1].y + v[2].y + v[3].y) / 4,
      w: Math.max(d(v[0], v[1]), 1),
      h: Math.max(d(v[1], v[2]), 1),
      ang
    };
  }
 
  function textColorFor(rgb) {
    const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    return l > 150 ? '#161616' : '#ffffff';
  }
  // ── Локальный OCR (PaddleOCR): постобработка детектора, CTC-декодер, склейка строк ──
 
  /**
   * Карта вероятностей детектора DBNet (w×h, 0..1) → прямоугольники строк текста.
   * Связные области выше порога, средняя уверенность ≥ boxThr, рамка расширяется (unclip), как в PaddleOCR.
   */
  function detBoxes(prob, w, h, opts) {
    const o = Object.assign({ thr: 0.3, boxThr: 0.5, unclip: 1.6, minSide: 3 }, opts || {});
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const out = [];
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || prob[start] <= o.thr) continue;
      let sp = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0, cnt = 0;
      stack[sp++] = start; seen[start] = 1;
      while (sp) {
        const i = stack[--sp];
        const x = i % w, y = (i - x) / w;
        sum += prob[i]; cnt++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0) { const j = i - 1; if (!seen[j] && prob[j] > o.thr) { seen[j] = 1; stack[sp++] = j; } }
        if (x < w - 1) { const j = i + 1; if (!seen[j] && prob[j] > o.thr) { seen[j] = 1; stack[sp++] = j; } }
        if (y > 0) { const j = i - w; if (!seen[j] && prob[j] > o.thr) { seen[j] = 1; stack[sp++] = j; } }
        if (y < h - 1) { const j = i + w; if (!seen[j] && prob[j] > o.thr) { seen[j] = 1; stack[sp++] = j; } }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (Math.min(bw, bh) < o.minSide) continue;
      const score = sum / cnt;
      if (score < o.boxThr) continue;
      const d = (bw * bh * o.unclip) / (2 * (bw + bh));
      out.push({
        x0: Math.max(0, x0 - d), y0: Math.max(0, y0 - d),
        x1: Math.min(w, x1 + 1 + d), y1: Math.min(h, y1 + 1 + d), score
      });
    }
    return out;
  }
 
  /** Выход распознавателя [T×C] (softmax) → текст: argmax, без «пустых» (индекс 0) и повторов. */
  function ctcDecode(data, T, C, chars) {
    let text = '', prev = -1, sc = 0, n = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bv = -Infinity;
      const base = t * C;
      for (let c = 0; c < C; c++) { const v = data[base + c]; if (v > bv) { bv = v; best = c; } }
      if (best !== 0 && best !== prev) { text += chars[best] || ''; sc += bv; n++; }
      prev = best;
    }
    return { text, score: n ? sc / n : 0 };
  }
 
  /** Список символов для распознавателя: blank + словарь (+ пробел, если классов на один больше). */
  function ctcChars(keysText, C) {
    const keys = String(keysText).replace(/\r/g, '').split('\n');
    if (keys.length && keys[keys.length - 1] === '') keys.pop();
    const chars = ['', ...keys];
    if (C === chars.length + 1) chars.push(' ');
    return chars;
  }
 
  /** Длинную картинку (описание товара) режем на перекрывающиеся полосы — мелкий текст не теряется при сжатии. */
  function tilesFor(W, H, maxAspect, overlap) {
    const ma = maxAspect || 1.5, ov = overlap === undefined ? 0.12 : overlap;
    const th = Math.round(W * ma);
    if (H <= th * 1.15) return [{ y0: 0, y1: H, k0: 0, k1: H }];
    const step = Math.round(th * (1 - ov));
    const tiles = [];
    for (let y = 0; ; y += step) {
      const y0 = Math.min(y, Math.max(0, H - th)), y1 = Math.min(H, y0 + th);
      tiles.push({ y0, y1 });
      if (y1 >= H) break;
    }
    // зона «ответственности» полосы: середина перекрытия с соседями
    tiles.forEach((t, i) => {
      t.k0 = i === 0 ? 0 : Math.round((t.y0 + tiles[i - 1].y1) / 2);
      t.k1 = i === tiles.length - 1 ? H : Math.round((tiles[i + 1].y0 + t.y1) / 2);
    });
    return tiles;
  }
 
  /** Строки → абзацы: соседние по вертикали строки одного кегля и колонки склеиваем (лучше перевод, ровнее плашки). */
  function mergeLines(lines) {
    const ls = lines.map((l) => Object.assign({}, l)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const out = [];
    const cjkEnd = /[㐀-鿿＀-￯]$/, cjkStart = /^[㐀-鿿＀-￯]/;
    for (const l of ls) {
      const lh = l.y1 - l.y0;
      let host = null;
      for (let i = out.length - 1; i >= 0 && i >= out.length - 6; i--) {
        const b = out[i];
        const bh = b.lh;
        const gap = l.y0 - b.y1;
        const ovl = Math.min(b.x1, l.x1) - Math.max(b.x0, l.x0);
        const narrow = Math.min(b.x1 - b.x0, l.x1 - l.x0);
        const sameSize = lh / bh > 0.75 && lh / bh < 1.33;
        if (sameSize && gap > -0.3 * bh && gap < 0.55 * bh && ovl > 0.5 * narrow) { host = b; break; }
      }
      if (host) {
        const glue = cjkEnd.test(host.text) || cjkStart.test(l.text) ? '' : ' ';
        host.text += glue + l.text;
        host.x0 = Math.min(host.x0, l.x0); host.x1 = Math.max(host.x1, l.x1); host.y1 = Math.max(host.y1, l.y1);
        host.n++;
      } else out.push({ text: l.text, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, lh, n: 1 });
    }
    return out;
  }
 
  const rectVerts = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  // </pure>
 
  /* ══════════════════════════════════════════════════════════════════════
   *  1. ХРАНИЛИЩЕ, СОСТОЯНИЕ, СЕТЬ
   * ══════════════════════════════════════════════════════════════════════ */
  const store = {
    get(key, def) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(key, def); } catch (_) { /* fallthrough */ }
      try { const v = localStorage.getItem('tbrub:' + key); return v === null ? def : JSON.parse(v); } catch (_) { return def; }
    },
    set(key, val) {
      try { if (typeof GM_setValue === 'function') return GM_setValue(key, val); } catch (_) { /* fallthrough */ }
      try { localStorage.setItem('tbrub:' + key, JSON.stringify(val)); } catch (_) { /* ignore */ }
    }
  };
  const numFromStore = (k) => Number(store.get(k, 0)) || 0;
 
  const state = {
    // курс
    manualRate: sanitizeRate(store.get('rate', DEFAULT_RATE)) || DEFAULT_RATE,
    auto: store.get('auto', true) !== false,
    usdtRub: numFromStore('usdtRub'),
    usdtRubTs: numFromStore('usdtRubTs'),
    usdtCnyManual: sanitizeRate(store.get('usdtCny', DEFAULT_USDT_CNY)) || DEFAULT_USDT_CNY,
    cnyAutoOn: store.get('cnyAutoOn', true) !== false,
    cnyAuto: numFromStore('cnyAuto'),
    cnyTs: numFromStore('cnyTs'),
    cnySrc: String(store.get('cnySrc', '')),
    rubError: false,
    cnyError: false,
    rate: DEFAULT_RATE,
    // отображение и функции
    mode: store.get('mode', 'beside') === 'replace' ? 'replace' : 'beside',
    pageTr: store.get('pageTr', true) !== false,        // перевод страницы Google — включён по умолчанию
    searchTr: store.get('searchTr', true) !== false,    // перевод поисковых запросов
    imgTr: store.get('imgTr', true) !== false,          // кнопки перевода картинок
    ocrEngine: ['auto', 'paddle', 'tesseract', 'vision'].includes(store.get('ocrEngine', 'auto')) ? store.get('ocrEngine', 'auto') : 'auto',
    imgAuto: store.get('imgAuto', false) === true,      // автоперевод фото на странице товара
    visionKey: String(store.get('visionKey', ''))       // ключ Google Cloud Vision (для перевода на картинке)
  };
 
  function usdtCnyEff() { return state.cnyAutoOn && state.cnyAuto > 0 ? state.cnyAuto : state.usdtCnyManual; }
  function calcRate() { return computeRate(state.auto, state.usdtRub, usdtCnyEff(), state.manualRate); }
  state.rate = calcRate();
 
  /** Запрос через GM_xmlhttpRequest (обход CORS/CSP), fallback — fetch. */
  function httpReq(opts) {
    const { method = 'GET', url, headers = {}, data, timeout = 7000 } = opts;
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method, url, data, timeout,
          headers: Object.assign({ Accept: 'application/json, text/plain, */*' }, headers),
          onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText)
            : reject(Object.assign(new Error('HTTP ' + r.status), { status: r.status, body: r.responseText }))),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout'))
        });
      } else {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeout);
        fetch(url, { method, body: data, headers, signal: ctl.signal })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then(resolve, reject)
          .finally(() => clearTimeout(t));
      }
    });
  }
 
  const gtxUrl = (sl, tl, q) => 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + sl +
    '&tl=' + tl + '&dt=t&q=' + encodeURIComponent(q);
 
  const fmtNum = (n, d) => n.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
 
  /* ══════════════════════════════════════════════════════════════════════
   *  2. СТИЛИ
   * ══════════════════════════════════════════════════════════════════════ */
  const CSS = `
.tb-rub{display:inline-block;margin:0 4px 0 6px;padding:0 5px;border-radius:4px;background:#fff1e6;color:#ff5000;
  font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:max(11px,.72em);font-weight:600;line-height:1.5;
  vertical-align:middle;white-space:nowrap;letter-spacing:0;text-decoration:none!important;text-transform:none;flex:none}
.tb-rub.tb-rub-compact{margin:0 0 0 3px;padding:0;background:transparent;font-size:.85em}
.tb-rub.tb-rub-gone{display:none!important}
.tb-rub.tb-rub-replace{margin:0 6px 0 0;padding:0;background:transparent;line-height:1.15;vertical-align:baseline}
[data-rub-hide]{display:none!important}
[data-rub-full]{font-size:0!important;letter-spacing:0!important}
[data-rub-full]>*:not(.tb-rub){display:none!important}
[data-rub-full]::before,[data-rub-full]::after{display:none!important}
/* Русский текст длиннее китайского: при включённом переводе снимаем жёсткую обрезку заголовков */
html.tbrub-tr [class*="MainTitle--"],html.tbrub-tr [class*="mainTitle--"]{white-space:normal!important;display:block!important;
  -webkit-line-clamp:unset!important;max-height:none!important;height:auto!important;overflow:visible!important;text-overflow:clip!important}
html.tbrub-tr [class*="ItemHeadFixed--"] [class*="MainTitle--"],html.tbrub-tr [class*="ItemHeadFixed--"] [class*="mainTitle--"]{
  white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
/* Обрезанные заголовки карточек: оригинал не трогаем (его рисует React), перевод — поверх, в тех же размерах.
   Геометрия карточки не меняется → Taobao не перестраивает сетку → страница не «дёргается». */
html.tbrub-tr [data-tbrub-tt]{position:relative!important;color:transparent!important}
html.tbrub-tr [data-tbrub-tt]>*{visibility:hidden!important}
html.tbrub-tr [data-tbrub-tt]::after{content:attr(data-tbrub-tt);position:absolute;left:0;top:0;right:0;bottom:0;visibility:visible;
  color:var(--tbrub-c,#333);font-size:var(--tbrub-fs,12px);line-height:var(--tbrub-lh,1.2);font-weight:400;text-align:left;
  font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--tbrub-n,2);overflow:hidden;white-space:normal;
  text-overflow:ellipsis;overflow-wrap:anywhere;text-indent:0;letter-spacing:0;pointer-events:none}
html.tbrub-tr [data-tbrub-tt]:hover::after{bottom:auto;display:block;-webkit-line-clamp:unset;background:#fff;color:#222;z-index:20;
  box-shadow:0 3px 10px rgba(0,0,0,.2);border-radius:4px;padding:0 3px 2px 0}
[data-tbrub-ann]::after{content:"  ·  " attr(data-tbrub-ann);color:#8a8f98;font-weight:400}
 
/* Шапка поиска: переведённые подписи кнопок шире 72px — переносим, не ломая геометрию */
html body .search-suggest-buttons-wrapper>div[class^="search-suggest-button"]{box-sizing:border-box!important;padding:0 3px!important;
  white-space:normal!important;word-break:normal!important;text-align:center!important;overflow:hidden!important;
  font-size:11px!important;font-weight:500!important;line-height:1.15!important}
html body #J_Search div[data-sg-type="placeholder"]{max-width:calc(100% - 200px)!important;overflow:hidden!important}
html body div[data-sg-type="placeholder"] .item{display:block!important;overflow:hidden!important;white-space:nowrap!important;
  text-overflow:ellipsis!important;max-width:100%!important}
 
#tbrub-root{all:initial;position:fixed;right:14px;bottom:14px;z-index:999999;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  font-size:12px;line-height:1.3;color:#fff}
#tbrub-root *{box-sizing:border-box;font-family:inherit}
#tbrub-root .tbrub-pill{all:unset;display:flex;align-items:center;gap:7px;padding:7px 12px;background:rgba(28,28,32,.93);color:#fff;
  border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;user-select:none;font-size:12px;font-weight:600;white-space:nowrap}
#tbrub-root .tbrub-pill:hover{background:rgba(45,45,52,.96)}
#tbrub-root .tbrub-dot{width:8px;height:8px;border-radius:50%;background:#9aa0a6;flex:none}
#tbrub-root .tbrub-dot.ok{background:#3ddc84}
#tbrub-root .tbrub-dot.stale{background:#ffb020}
#tbrub-root .tbrub-tag{font-size:11px;font-weight:600;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.14);color:#cfd3da}
#tbrub-root .tbrub-tag.on{background:#ff5000;color:#fff}
#tbrub-root .tbrub-panel{position:absolute;right:0;bottom:44px;width:320px;max-height:calc(100vh - 80px);overflow:auto;padding:12px;background:#1f2024;color:#e8eaed;border-radius:12px;
  box-shadow:0 10px 30px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:10px}
#tbrub-root .tbrub-panel[hidden]{display:none}
#tbrub-root .tbrub-h{font-size:11px;font-weight:600;color:#9aa0a6;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px}
#tbrub-root .tbrub-big{font-size:18px;font-weight:700;color:#fff}
#tbrub-root .tbrub-sub{font-size:11px;color:#9aa0a6;line-height:1.4;word-break:break-word}
#tbrub-root .tbrub-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#tbrub-root .tbrub-sw{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:#e8eaed}
#tbrub-root button.tbrub-b{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;
  font-size:12px;line-height:1.3;white-space:nowrap}
#tbrub-root button.tbrub-b:hover{background:rgba(255,255,255,.24)}
#tbrub-root button.tbrub-b.sel{background:#ff5000}
#tbrub-root button.tbrub-t{all:unset;cursor:pointer;width:36px;height:20px;border-radius:999px;background:#5f6368;position:relative;flex:none}
#tbrub-root button.tbrub-t::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
#tbrub-root button.tbrub-t.on{background:#ff5000}
#tbrub-root button.tbrub-t.on::after{left:18px}
#tbrub-root .tbrub-sep{height:1px;background:rgba(255,255,255,.1)}
/* Перевод на картинке */
.tbrub-ocr{position:fixed;left:0;top:0;overflow:hidden;pointer-events:none;z-index:2000}
.tbrub-ocr-g{position:absolute;left:0;top:0;transform-origin:0 0}
.tbrub-ocr-b{position:absolute;display:flex;align-items:center;justify-content:center;overflow:hidden;box-sizing:border-box;
  border-radius:3px;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.tbrub-ocr-b span{display:block;width:100%;text-align:center;line-height:1.05;font-weight:600;overflow-wrap:normal;word-break:normal}
#tbrub-imgbtn{all:initial;position:fixed;z-index:999998;display:none;gap:4px;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
#tbrub-imgbtn button{all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;background:rgba(28,28,32,.88);color:#fff;
  font-size:12px;font-weight:600;line-height:1.2;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)}
#tbrub-imgbtn button:hover{background:#ff5000}
#tbrub-toast{all:initial;position:fixed;right:14px;bottom:60px;z-index:999999;max-width:360px;padding:8px 12px;border-radius:10px;
  background:rgba(28,28,32,.95);color:#fff;font:12px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)}
`;
 
  /** Выполнить, когда появится <html> (на document-start его может ещё не быть). */
  function whenRoot(fn) {
    if (document.documentElement) { fn(); return; }
    const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); fn(); } });
    mo.observe(document, { childList: true });
  }
 
  function addStyle(css) {
    whenRoot(() => {
      try { if (typeof GM_addStyle === 'function') { GM_addStyle(css); return; } } catch (_) { /* fallthrough */ }
      const st = document.createElement('style');
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    });
  }
 
  let toastTimer = 0;
  function toast(text, ms) {
    if (!document.body) return;
    let el = document.getElementById('tbrub-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tbrub-toast';
      el.setAttribute('translate', 'no');
      el.className = 'notranslate';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms || 2500);
  }
 
  /* ══════════════════════════════════════════════════════════════════════
   *  3. КУРС: Rapira USDT/RUB ÷ USDT/CNY (P2P Binance/OKX → форекс OKX/Sina)
   * ══════════════════════════════════════════════════════════════════════ */
  const RATE_TTL_MS = 5 * 60 * 1000;
  const fresh = (ts) => ts > 0 && Date.now() - ts < RATE_TTL_MS;
 
  async function fetchRub() {
    try {
      const v = parseRapira(JSON.parse(await httpReq({ url: 'https://api.rapira.net/market/symbol-thumb' })));
      if (!v) throw new Error('USDT/RUB не найден в ответе Rapira');
      state.usdtRub = v; state.usdtRubTs = Date.now(); state.rubError = false;
      store.set('usdtRub', v); store.set('usdtRubTs', state.usdtRubTs);
    } catch (e) {
      state.rubError = true;
      console.warn('[tb-rub] Rapira недоступна:', e);
    }
  }
 
  const CNY_SOURCES = {
    binance: () => httpReq({
      method: 'POST',
      url: 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ page: 1, rows: 10, payTypes: [], asset: 'USDT', tradeType: 'SELL', fiat: 'CNY', publisherType: null })
    }).then((t) => parseBinanceP2P(JSON.parse(t))),
    okxP2p: () => httpReq({
      url: 'https://www.okx.com/v3/c2c/tradingOrders/books?t=' + Date.now() +
        '&quoteCurrency=CNY&baseCurrency=USDT&side=sell&paymentMethod=all&userType=all&showTrade=false' +
        '&receivingAds=false&showFollow=false&showAlreadyTraded=false&isAbleFilter=false'
    }).then((t) => parseOkxP2P(JSON.parse(t))),
    okxFx: () => httpReq({ url: 'https://www.okx.com/api/v5/market/exchange-rate' }).then((t) => parseOkxFx(JSON.parse(t))),
    sina: () => httpReq({ url: 'https://hq.sinajs.cn/list=fx_susdcny', headers: { Referer: 'https://finance.sina.com.cn/' } }).then(parseSinaFx)
  };
 
  async function fetchCny() {
    const keys = Object.keys(CNY_SOURCES);
    const res = await Promise.allSettled(keys.map((k) => CNY_SOURCES[k]()));
    const got = {};
    res.forEach((r, i) => { got[keys[i]] = r.status === 'fulfilled' ? r.value : null; });
    console.info('[tb-rub] USDT/CNY источники:', got,
      res.map((r, i) => (r.status === 'rejected' ? keys[i] + ': ' + (r.reason && r.reason.message) : null)).filter(Boolean));
    const pick = pickUsdtCny(got);
    if (!pick) { state.cnyError = true; return; }
    state.cnyAuto = pick.value; state.cnyTs = Date.now(); state.cnyError = false;
    state.cnySrc = pick.kind + ': ' + pick.parts.map((x) => x[0] + ' ' + fmtNum(x[1], 2)).join(', ');
    store.set('cnyAuto', state.cnyAuto); store.set('cnyTs', state.cnyTs); store.set('cnySrc', state.cnySrc);
  }
 
  function applyRate() {
    const r = calcRate();
    const changed = r !== state.rate;
    state.rate = r;
    if (changed && document.body) Prices.fullScan();
    Ui.render();
  }
 
  /** Обновляет оба курса (кэш 5 минут, общий для вкладок). */
  async function syncRates(force) {
    if (!state.auto) { applyRate(); return; }
    if (numFromStore('usdtRubTs') > state.usdtRubTs) { state.usdtRub = numFromStore('usdtRub'); state.usdtRubTs = numFromStore('usdtRubTs'); }
    if (numFromStore('cnyTs') > state.cnyTs) {
      state.cnyAuto = numFromStore('cnyAuto'); state.cnyTs = numFromStore('cnyTs'); state.cnySrc = String(store.get('cnySrc', ''));
    }
    const jobs = [];
    if (force || !fresh(state.usdtRubTs)) jobs.push(fetchRub());
    if (state.cnyAutoOn && (force || !fresh(state.cnyTs))) jobs.push(fetchCny());
    if (jobs.length) await Promise.all(jobs);
    applyRate();
  }
 
  /* ══════════════════════════════════════════════════════════════════════
   *  4. ЦЕНЫ ¥ → ₽
   *  Модель «сегмента»: [символ ¥] + [соседние узлы с цифрами] (поиск, главная, карточка),
   *  либо цена целиком в одном элементе («¥0.3», «约省¥0.68»). Хэшированные классы не нужны.
   * ══════════════════════════════════════════════════════════════════════ */
  const IGNORE_SEL = '#tbrub-root,#tbrub-toast,#tbrub-imgbtn,.tbrub-ocr,.tb-rub,script,style,noscript,textarea,template';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);
 
  function ownText(el) {
    if (el.nodeType === 3) return el.nodeValue.replace(/\s+/g, ' ').trim();
    let out = '';
    (function walk(n) {
      for (let c = n.firstChild; c && out.length <= 220; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !c.classList.contains('tb-rub') && !SKIP_TAGS.has(c.tagName)) walk(c);
      }
    })(el);
    return out.replace(/\s+/g, ' ').trim();
  }
 
  const Prices = (() => {
    const recs = new Map();          // anchor (Element | Text) → запись сегмента
    const partOf = new WeakMap();    // узел сегмента → anchor
 
    /** Числовые узлы, идущие сразу после символа ¥. */
    function collectNums(anchor) {
      let acc = '', nodes = [], best = null;
      for (let s = anchor.nextSibling; s; s = s.nextSibling) {
        if (s.nodeType === 8) continue;
        if (s.nodeType === 1 && s.classList.contains('tb-rub')) continue;
        if (s.nodeType !== 1 && s.nodeType !== 3) continue;
        if (s.nodeType === 1 && SKIP_TAGS.has(s.tagName)) continue;
        const t = (s.nodeType === 3 ? s.nodeValue : ownText(s)).replace(/\s+/g, '');
        if (!t) continue;                                    // пустые иконки/пробелы
        if (!isNumFrag(t) || !canAppendFrag(acc, t)) break;
        acc += t;
        nodes.push(s);
        const r = parseNumPart(acc);
        if (r) best = { nodes: nodes.slice(), info: r, text: acc };
      }
      return best;
    }
 
    /** Самый внутренний элемент, чей текст целиком — цена (подпись допускается). */
    function findWhole(start) {
      let cur = start, found = null, fi = null;
      for (let i = 0; cur && cur !== document.body && i < 4; i++, cur = cur.parentElement) {
        const t = ownText(cur);
        if (t.length > 100) break;
        const info = parsePrice(t, true);
        if (info) { if (!found || info.lo !== fi.lo || info.hi !== fi.hi) { found = cur; fi = info; } }
        else if (found) break;
      }
      return found ? { anchor: found, kind: 'whole', nodes: [found], info: fi, sig: ownText(found) } : null;
    }
 
    /** Определение сегмента по текстовому узлу со знаком ¥. */
    function detectAt(textNode) {
      const p = textNode.parentElement;
      if (!p || p.closest(IGNORE_SEL)) return null;
      const v = textNode.nodeValue.trim();
      if (/^[¥￥]$/.test(v)) {
        let a = ownText(p) === v ? p : textNode;              // элемент-символ или голый текстовый узел
        if (a === textNode) {                                  // «¥» голым текстом рядом с числом: лучше целиком
          const whole = findWhole(p);
          if (whole) return whole;
        }
        for (let i = 0; i < 2 && a.nodeType === 1 && a.parentElement && ownText(a.parentElement) === v; i++) a = a.parentElement;
        const n = collectNums(a);
        if (n) return { anchor: a, kind: 'sym', nodes: [a].concat(n.nodes), info: n.info, sig: v + n.text };
      }
      return findWhole(p);
    }
 
    /** Повторное определение для существующей записи (смена SKU, перерисовка React). */
    function redetect(rec) {
      if (!rec.anchor.isConnected) return null;
      if (rec.kind === 'sym') {
        const n = collectNums(rec.anchor);
        return n ? { anchor: rec.anchor, kind: 'sym', nodes: [rec.anchor].concat(n.nodes), info: n.info, sig: ownText(rec.anchor) + n.text } : null;
      }
      const t = ownText(rec.anchor);
      const info = parsePrice(t, rec.kind === 'whole');
      return info ? { anchor: rec.anchor, kind: rec.kind, nodes: [rec.anchor], info, sig: t } : null;
    }
 
    function sameNodes(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
 
    function badgeOk(rec) {
      const b = rec.badge;
      if (!b || !b.isConnected) return false;
      if (rec.kind === 'sym') return rec.nodes[rec.nodes.length - 1].nextSibling === b;
      return b.parentNode === rec.anchor;
    }
 
    function unpaint(rec) {
      if (rec.badge && rec.badge.parentNode) rec.badge.remove();
      for (const n of rec.nodes) {
        if (n.nodeType === 1) n.removeAttribute('data-rub-hide');
        partOf.delete(n);
      }
      if (rec.anchor.nodeType === 1) {
        rec.anchor.removeAttribute('data-rub-done');
        rec.anchor.removeAttribute('data-rub-full');
      }
      recs.delete(rec.anchor);
    }
 
    /** Стиль цифр для режима «Замена» (читается до записи — без layout thrashing). */
    function readStyle(seg) {
      let host = null;
      for (const n of seg.nodes) {
        if (n.nodeType === 1 && /\d/.test(ownText(n))) {
          const tw = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
          let t;
          while ((t = tw.nextNode())) if (/\d/.test(t.nodeValue)) { host = t.parentElement; break; }
          if (host) break;
        }
      }
      host = host || (seg.anchor.nodeType === 1 ? seg.anchor : seg.anchor.parentElement);
      const cs = getComputedStyle(host);
      return { fontSize: parseFloat(cs.fontSize) > 0 ? cs.fontSize : '16px', fontWeight: cs.fontWeight, color: cs.color, fontFamily: cs.fontFamily };
    }
 
    function paint(seg, style) {
      const { info } = seg;
      const rub = info.hi !== null && info.hi !== info.lo
        ? formatRub(info.lo, state.rate) + '–' + formatRub(info.hi, state.rate) + ' ₽'
        : formatRub(info.lo, state.rate) + ' ₽';
      const badge = document.createElement('span');
      badge.className = 'tb-rub notranslate';
      badge.setAttribute('translate', 'no');
      const original = seg.sig.replace(/^[^¥￥\d]*/, '');
      const rec = { anchor: seg.anchor, kind: seg.kind, nodes: seg.nodes, sig: seg.sig, rate: state.rate, mode: state.mode, badge, replaced: false };
 
      // «Замена» возможна, если все узлы цены — элементы (их можно скрыть), либо цена целиком в одном элементе
      const canHide = seg.kind === 'sym' && seg.nodes.every((n) => n.nodeType === 1);
      if (state.mode === 'replace' && (canHide || seg.kind !== 'sym')) {
        rec.replaced = true;
        badge.classList.add('tb-rub-replace');
        badge.textContent = (seg.kind !== 'sym' && info.prefix ? info.prefix + ' ' : '') + rub;
        badge.title = 'Оригинал: ' + original + ' · 1 ¥ = ' + fmtNum(state.rate, 2) + ' ₽';
        if (style) {
          badge.style.fontSize = style.fontSize; badge.style.fontWeight = style.fontWeight;
          badge.style.color = style.color; badge.style.fontFamily = style.fontFamily;
        }
      } else {
        badge.textContent = '≈ ' + rub;
        badge.title = original + ' · 1 ¥ = ' + fmtNum(state.rate, 2) + ' ₽';
      }
 
      if (seg.kind === 'sym') {
        if (rec.replaced) seg.nodes.forEach((n) => n.setAttribute('data-rub-hide', ''));
        seg.nodes[seg.nodes.length - 1].after(badge);
      } else {
        if (rec.replaced) seg.anchor.setAttribute('data-rub-full', '');
        seg.anchor.appendChild(badge);
      }
      if (seg.anchor.nodeType === 1) seg.anchor.setAttribute('data-rub-done', '');
      seg.nodes.forEach((n) => partOf.set(n, seg.anchor));
      recs.set(seg.anchor, rec);
    }
 
    /** Применяет набор сегментов: решения → снятие старого → чтение стилей → запись. */
    function commit(segs) {
      const jobs = [];
      const seen = new Set();
      for (const seg of segs) {
        if (seen.has(seg.anchor)) continue;
        seen.add(seg.anchor);
        const old = recs.get(seg.anchor);
        if (old) {
          if (old.sig === seg.sig && old.rate === state.rate && old.mode === state.mode &&
              sameNodes(old.nodes, seg.nodes) && badgeOk(old) &&
              (!old.replaced || old.kind !== 'sym' || old.nodes.every((n) => n.hasAttribute('data-rub-hide')))) continue;
          jobs.push({ seg, old });
        } else {
          // узел уже входит в другой сегмент — пропускаем
          if (seg.nodes.some((n) => partOf.has(n) && partOf.get(n) !== seg.anchor)) continue;
          jobs.push({ seg, old: null });
        }
      }
      if (!jobs.length) return;
      for (const j of jobs) if (j.old) unpaint(j.old);
      const styles = state.mode === 'replace' ? jobs.map((j) => readStyle(j.seg)) : [];
      jobs.forEach((j, i) => paint(j.seg, styles[i]));
      fitBadges(jobs.map((j) => recs.get(j.seg.anchor)).filter(Boolean));
    }
 
    /** Узкие ячейки с обрезкой: сначала компактный бейдж, если не влезает — рубли уходят в подсказку. */
    function clipped(h) {
      if (!h || h.clientWidth === 0) return false;
      const cs = getComputedStyle(h);
      return (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis') && h.scrollWidth > h.clientWidth + 1;
    }
    function fitBadges(list) {
      const beside = list.filter((r) => !r.replaced && r.badge.isConnected);
      if (!beside.length) return;
      requestAnimationFrame(() => {
        const tight = beside.filter((r) => clipped(r.badge.parentElement) || clipped(r.badge.parentElement && r.badge.parentElement.parentElement));
        tight.forEach((r) => { r.badge.classList.add('tb-rub-compact'); r.badge.textContent = r.badge.textContent.replace('≈ ', '≈'); });
        requestAnimationFrame(() => {
          tight.filter((r) => clipped(r.badge.parentElement) || clipped(r.badge.parentElement && r.badge.parentElement.parentElement))
            .forEach((r) => {
              r.badge.classList.add('tb-rub-gone');
              const host = r.anchor.nodeType === 1 ? r.anchor : r.anchor.parentElement;
              if (host && !host.title) host.title = r.badge.title.replace(/ ·.*/, '') + ' ' + r.badge.textContent;
            });
        });
      });
    }
 
    /** Проверка всех существующих записей: удалённые → убрать бейдж, изменённые → перерисовать. */
    function sweep(out) {
      for (const rec of Array.from(recs.values())) {
        const seg = redetect(rec);
        if (!seg) { unpaint(rec); continue; }
        out.push(seg);
      }
    }
 
    function collect(root, out) {
      if (!root || root.nodeType !== 1 || root.closest(IGNORE_SEL)) return;
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        const v = n.nodeValue;
        if (v.indexOf('¥') < 0 && v.indexOf('￥') < 0) continue;
        if (partOf.has(n) || (n.parentElement && partOf.has(n.parentElement) && recs.has(partOf.get(n.parentElement)))) continue;
        const seg = detectAt(n);
        if (seg) out.push(seg);
      }
      // цены без символа ¥ в DOM (символ нарисован CSS)
      const SEL = '[class*="priceInt"]';
      const hints = Array.from(root.querySelectorAll(SEL));
      if (root.matches && root.matches(SEL)) hints.unshift(root);
      for (const el of hints) {
        let covered = false;
        for (let a = el, i = 0; a && i < 4; a = a.parentElement, i++) if (partOf.has(a)) { covered = true; break; }
        if (covered || el.closest(IGNORE_SEL)) continue;
        const w = el.parentElement;
        if (!w) continue;
        const sib = w.previousElementSibling;
        if (sib && /^[¥￥]$/.test(ownText(sib))) continue;   // будет найдено как сегмент с символом
        const t = ownText(w);
        if (NOSYM_RE.test(t) && num(t) > 0) out.push({ anchor: w, kind: 'nosym', nodes: [w], info: { prefix: '', lo: num(t), hi: null }, sig: t });
      }
    }
 
    function scanRoots(roots) {
      const segs = [];
      sweep(segs);
      for (const r of roots) if (r && r.isConnected) collect(r, segs);
      commit(segs);
    }
 
    return {
      scanRoots,
      fullScan() { if (document.body) scanRoots([document.body]); },
      count: () => recs.size
    };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  5. ПЕРЕВОД СТРАНИЦЫ (Google, zh → ru)
   *  Переводим только то, что рядом с экраном (IntersectionObserver), догружаемые блоки — через
   *  общий MutationObserver. Оригиналы хранятся, выключение восстанавливает текст без перезагрузки.
   * ══════════════════════════════════════════════════════════════════════ */
  const TL = 'ru';
  const TR_SKIP_SEL = '#tbrub-root,#tbrub-toast,#tbrub-imgbtn,.tbrub-ocr,.tb-rub,script,style,noscript,textarea,code,pre,select,option,[contenteditable=""],[contenteditable="true"]';
  // Подсказки поиска: их текст читает сам Taobao при клике, поэтому перевод показываем рядом, не заменяя
  const TR_ANNOTATE_SEL = '.search-suggest-menu,.search-suggest-popup,[data-sg-type="placeholder"]';
  const TR_MAX_LEN = 400;
  const TR_MAX_ENC = 3500;
  const TR_CONCURRENCY = 3;
  // Заголовки, которые нельзя переводить «на месте» (полный заголовок товара на его странице мы как раз раскрываем)
  const BOX_EXCLUDE_SEL = '[class*="MainTitle--"],[class*="mainTitle--"],' + TR_ANNOTATE_SEL;
  const FIGHT_WINDOW_MS = 20000;   // если страница дважды за это время вернула оригинал — перестаём писать в узел
 
  const Translator = (() => {
    const CACHE_KEY = 'pageTrCache2';                 // новая версия: старый кэш содержал ошибки без словаря
    const cache = new Map(Object.entries(store.get(CACHE_KEY, {}) || {}));
    if (store.get('pageTrCache', null)) store.set('pageTrCache', {});
    const written = new WeakMap();   // текстовый узел → значение, которое записали мы
    const original = new WeakMap();  // текстовый узел → оригинал
    const touched = new Set();       // для восстановления при выключении
    const touchedAttr = new Map();   // элемент → {attr: оригинал}
    const waiting = new Map();       // core → [задачи]
    const fails = new Map();         // core → число неудач
    let activated = new WeakSet();
    let observed = new WeakSet();
    let boxSrc = new WeakMap();      // плашка → текст оригинала, для которого она поставлена/заказана
    const boxes = new Set();
    let fight = new WeakMap();       // элемент → {orig:Set, n, t} — сколько раз страница возвращала оригинал
    let contested = new WeakSet();   // элементы, за которые «борется» React: только плашка, без записи в текст
    let io = null;
    let running = 0, timer = 0, pauseUntil = 0, saveTimer = 0;
    const stats = { done: 0, errors: 0 };
 
    function persist() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const entries = Array.from(cache.entries());
        const keep = entries.slice(-6000);
        if (keep.length < entries.length) { cache.clear(); keep.forEach(([k, v]) => cache.set(k, v)); }
        store.set(CACHE_KEY, Object.fromEntries(keep));
      }, 4000);
    }
 
    const split = (s) => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
      return { lead: m[1], core: m[2], trail: m[3] };
    };
 
    function skipEl(el) {
      if (!el || el.closest(TR_SKIP_SEL)) return true;
      const nt = el.closest('.notranslate,[translate="no"]');
      return !!(nt && nt !== document.documentElement);
    }
 
    function wanted(text) {
      return CJK_RE.test(text) && !/[¥￥]\s*\d/.test(text);    // текст с ценами не трогаем
    }
 
    function apply(task, tr) {
      if (task.type === 'text') {
        const t = task.node;
        if (!t.isConnected || t.nodeValue !== task.full) return;     // узел успел измениться
        const { lead, trail } = split(task.full);
        if (task.annotate) {
          const p = t.parentElement;
          if (p) p.setAttribute('data-tbrub-ann', tr);
          return;
        }
        const nv = lead + tr + trail;
        noteWrite(t, task.full);
        original.set(t, task.full);
        written.set(t, nv);
        touched.add(t);
        t.nodeValue = nv;
        if (t.parentElement) queueClipCheck(t.parentElement);
      } else if (task.type === 'tip') {
        const el = task.el;
        if (!el.isConnected) return;
        const rec = touchedAttr.get(el) || {};
        if (!('title' in rec)) rec.title = el.getAttribute('title');
        touchedAttr.set(el, rec);
        el.setAttribute('title', split(task.full).core + ' — ' + tr);
      } else if (task.type === 'box') {
        const box = task.box;
        if (!box.isConnected || normText(box) !== task.full || boxSrc.get(box) !== task.full) return;
        layoutBox(box);
        box.setAttribute('data-tbrub-tt', tr);
        boxes.add(box);
        const rec = touchedAttr.get(box) || {};
        if (!('title' in rec)) rec.title = box.getAttribute('title');
        touchedAttr.set(box, rec);
        box.setAttribute('title', tr);
      } else {
        const { el, attr } = task;
        if (!el.isConnected || el.getAttribute(attr) !== task.full) return;
        const rec = touchedAttr.get(el) || {};
        if (!(attr in rec)) rec[attr] = task.full;
        touchedAttr.set(el, rec);
        el.setAttribute(attr, tr);
      }
      stats.done++;
    }
 
    /** Обрезанный перевод (многоточие, ограничение строк): полный текст — во всплывающей подсказке. */
    const clipSet = new Set();
    let clipRaf = 0;
    function isClipped(el) {
      if (!el || el.nodeType !== 1 || el.clientWidth === 0) return false;
      const cs = getComputedStyle(el);
      const clips = cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none';
      return clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2);
    }
    function queueClipCheck(el) {
      clipSet.add(el);
      if (clipRaf) return;
      clipRaf = requestAnimationFrame(() => {
        clipRaf = 0;
        const list = Array.from(clipSet);
        clipSet.clear();
        const hits = list.filter((el) => {
          if (!el.isConnected) return false;
          for (let a = el, i = 0; a && i < 4; a = a.parentElement, i++) if (isClipped(a)) return true;
          return false;
        });
        for (const el of hits) {
          if (el.hasAttribute('title') && CJK_RE.test(el.getAttribute('title')) === false) continue;
          const rec = touchedAttr.get(el) || {};
          if (!('title' in rec)) rec.title = el.getAttribute('title');   // null → при выключении удалить
          touchedAttr.set(el, rec);
          el.setAttribute('title', (el.textContent || '').replace(/\s+/g, ' ').trim());
        }
      });
    }
 
    const normText = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
 
    /** Запоминаем, что писали в узел: если страница вернёт оригинал — это «борьба». */
    function noteWrite(t, full) {
      const core = split(full).core;
      for (let a = t.parentElement, i = 0; a && i < 2; a = a.parentElement, i++) {
        const f = fight.get(a) || { orig: new Set(), n: 0, t: 0 };
        f.orig.add(core);
        if (f.orig.size > 30) f.orig.delete(f.orig.values().next().value);
        fight.set(a, f);
      }
    }
 
    /** Новый китайский узел с тем же текстом, что мы уже переводили в этом месте → страница откатила перевод. */
    function checkRevert(t) {
      const core = split(t.nodeValue).core;
      for (let a = t.parentElement, i = 0; a && i < 2; a = a.parentElement, i++) {
        const f = fight.get(a);
        if (!f || !f.orig.has(core)) continue;
        const now = Date.now();
        f.n = now - f.t > FIGHT_WINDOW_MS ? 1 : f.n + 1;
        f.t = now;
        if (f.n >= 2 && !contested.has(a)) {
          contested.add(a);
          console.info('[tb-rub] страница возвращает оригинал — перевод этого блока показываю поверх, не меняя текст', a);
        }
        return;
      }
    }
 
    function isContested(t) {
      for (let a = t.parentElement, i = 0; a && i < 2; a = a.parentElement, i++) if (contested.has(a)) return true;
      return false;
    }
 
    function isClampBox(cs) {
      const n = parseInt(cs.webkitLineClamp, 10);
      return n >= 2;
    }
 
    /** Контейнер, перевод которого показываем «плашкой» поверх (без изменения текста и размеров). */
    function boxFor(t) {
      const p = t.parentElement;
      if (!p) return null;
      const own = p.closest('[data-tbrub-tt]');
      if (own && own.contains(t)) return own;
      let forced = null;
      for (let a = p, i = 0; a && i < 2; a = a.parentElement, i++) if (contested.has(a)) { forced = a; break; }
      for (let a = forced || p, i = 0; a && i < 4 && a !== document.body; a = a.parentElement, i++) {
        const cs = getComputedStyle(a);
        if (cs.display === 'inline' && !forced) continue;
        if (forced || isClampBox(cs)) {
          if (cs.display === 'inline') { forced = null; continue; }
          if (a.matches(BOX_EXCLUDE_SEL) || a.closest(BOX_EXCLUDE_SEL)) return null;
          if (a.clientHeight < 8 || a.clientHeight > 140 || a.clientWidth < 24) return null;
          if (a.querySelector('.tb-rub,input,textarea,select,button')) return null;
          const txt = normText(a);
          if (!txt || txt.length > TR_MAX_LEN || /[¥￥]\s*\d/.test(txt)) return null;
          return a;
        }
      }
      return null;
    }
 
    /** Размер шрифта и число строк плашки — строго внутри исходной рамки. */
    function layoutBox(box) {
      const cs = getComputedStyle(box);
      const h = box.clientHeight;
      const f0 = parseFloat(cs.fontSize) || 13;
      const clamp = parseInt(cs.webkitLineClamp, 10) || Math.max(1, Math.round(h / (f0 * 1.3)));
      let n = clamp + 1, lh = h / n, fs = Math.min(f0, lh / 1.12);
      if (fs < 10.5) { n = clamp; lh = h / n; fs = Math.min(f0, lh / 1.12); }
      const st = box.style;
      st.setProperty('--tbrub-n', String(n));
      st.setProperty('--tbrub-lh', lh.toFixed(2) + 'px');
      st.setProperty('--tbrub-fs', fs.toFixed(2) + 'px');
      st.setProperty('--tbrub-c', cs.color === 'rgba(0, 0, 0, 0)' ? '#333' : cs.color);
    }
 
    function enqueueBox(box) {
      const txt = normText(box);
      if (boxSrc.get(box) === txt) return;
      boxSrc.set(box, txt);
      if (box.hasAttribute('data-tbrub-tt')) box.removeAttribute('data-tbrub-tt');   // текст сменился — старый перевод не показываем
      if (!wanted(txt)) return;
      enqueue({ type: 'box', box, full: txt });
    }
 
    function enqueue(task) {
      const { core } = split(task.full);
      if (!core || core.length > TR_MAX_LEN) return;
      const local = localTranslate(core);
      if (local !== null) { apply(task, local); return; }
      const hit = cache.get(core);
      if (hit !== undefined) { apply(task, hit); return; }
      if ((fails.get(core) || 0) >= 3) return;
      const list = waiting.get(core);
      if (list) list.push(task); else waiting.set(core, [task]);
      schedule();
    }
 
    function enqueueText(t) {
      if (!state.pageTr) return;
      const v = t.nodeValue;
      if (!v || written.get(t) === v || !wanted(v)) return;
      const p = t.parentElement;
      if (skipEl(p)) return;
      checkRevert(t);
      const annotate = !!p.closest(TR_ANNOTATE_SEL);
      const box = annotate ? null : boxFor(t);
      if (box) { enqueueBox(box); return; }
      if (!annotate && isContested(t)) {
        // плашку поставить некуда (слишком маленький элемент) — перевод только во всплывающей подсказке
        if (!p.hasAttribute('title') || CJK_RE.test(p.getAttribute('title'))) enqueue({ type: 'tip', el: p, full: v });
        return;
      }
      enqueue({ type: 'text', node: t, full: v, annotate });
    }
 
    function activate(el) {
      for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) enqueueText(c);
      for (const attr of ['title', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v && wanted(v)) enqueue({ type: 'attr', el, attr, full: v });
      }
    }
 
    function onIntersect(entries) {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        activated.add(e.target);
        activate(e.target);
      }
    }
 
    /** Регистрирует элементы с китайским текстом внутри root. */
    function scan(root) {
      if (!state.pageTr || !io || !root) return;
      if (root.nodeType === 3) { handleText(root); return; }
      if (root.nodeType !== 1 || skipEl(root)) return;
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) if (CJK_RE.test(n.nodeValue)) handleText(n);
      // атрибуты title/placeholder у элементов без китайского текста
      root.querySelectorAll('[title],[placeholder]').forEach((el) => {
        const v = el.getAttribute('title') || el.getAttribute('placeholder');
        if (v && CJK_RE.test(v)) watchEl(el);
      });
    }
 
    function watchEl(el) {
      if (activated.has(el)) { activate(el); return; }
      if (observed.has(el) || skipEl(el)) return;
      observed.add(el);
      io.observe(el);
    }
 
    function handleText(t) {
      if (written.get(t) === t.nodeValue) return;
      const el = t.parentElement;
      if (!el) return;
      if (activated.has(el)) enqueueText(t); else watchEl(el);
    }
 
    function schedule() {
      if (timer) return;
      timer = setTimeout(pump, Math.max(60, pauseUntil - Date.now()));
    }
 
    /** Отправка батчей в Google с ограничением параллельности и обработкой сбоев. */
    function pump() {
      timer = 0;
      if (!state.pageTr) return;
      if (Date.now() < pauseUntil) { schedule(); return; }
      const free = TR_CONCURRENCY - running;
      if (free <= 0 || !waiting.size) { Ui.renderStatus(); return; }
      const cores = Array.from(waiting.keys()).filter((c) => !inflight.has(c));
      const batches = buildBatches(cores, TR_MAX_ENC).slice(0, free);
      batches.forEach(send);
      Ui.renderStatus();
    }
 
    const inflight = new Set();
 
    async function send(batch) {
      batch.forEach((c) => inflight.add(c));
      running++;
      try {
        const data = JSON.parse(await httpReq({ url: gtxUrl('zh-CN', TL, batch.map(prepForGoogle).join('\n')), timeout: 10000 }));
        const joined = parseGtx(data);
        const parts = batch.length === 1 ? [joined.trim()] : splitGtx(joined, batch.length);
        if (!parts) {
          // Google склеил строки — делим батч пополам и отправляем заново
          batch.forEach((c) => inflight.delete(c));
          running--;
          const mid = Math.ceil(batch.length / 2);
          send(batch.slice(0, mid)); send(batch.slice(mid));
          return;
        }
        batch.forEach((core, i) => {
          const tr = parts[i] || core;
          cache.set(core, tr);
          const tasks = waiting.get(core) || [];
          waiting.delete(core);
          tasks.forEach((t) => apply(t, tr));
        });
        persist();
      } catch (e) {
        stats.errors++;
        batch.forEach((c) => fails.set(c, (fails.get(c) || 0) + 1));
        batch.filter((c) => (fails.get(c) || 0) >= 3).forEach((c) => waiting.delete(c));
        pauseUntil = Date.now() + (/HTTP 429/.test(String(e)) ? 30000 : 5000);
        console.warn('[tb-rub] перевод страницы: ошибка Google', e);
      }
      batch.forEach((c) => inflight.delete(c));
      running--;
      schedule();
    }
 
    function start() {
      if (io || !document.body) return;
      document.documentElement.setAttribute('translate', 'no');   // просим браузер не переводить поверх нас
      document.documentElement.classList.add('notranslate', 'tbrub-tr');
      io = new IntersectionObserver(onIntersect, { rootMargin: '700px 0px 700px 0px' });
      scan(document.body);
    }
 
    function stop() {
      if (io) io.disconnect();
      io = null;
      activated = new WeakSet();
      observed = new WeakSet();
      waiting.clear();
      document.documentElement.removeAttribute('translate');
      document.documentElement.classList.remove('notranslate', 'tbrub-tr');
      for (const t of touched) {
        if (t.isConnected && t.nodeValue === written.get(t)) {
          written.delete(t);                 // чтобы при повторном включении узел снова перевёлся
          t.nodeValue = original.get(t);
        }
      }
      touched.clear();
      for (const box of boxes) {
        box.removeAttribute('data-tbrub-tt');
        ['--tbrub-n', '--tbrub-lh', '--tbrub-fs', '--tbrub-c'].forEach((p) => box.style.removeProperty(p));
      }
      boxes.clear();
      boxSrc = new WeakMap();
      fight = new WeakMap();
      contested = new WeakSet();
      for (const [el, attrs] of touchedAttr) {
        for (const a in attrs) {
          if (!el.isConnected) continue;
          if (attrs[a] === null) el.removeAttribute(a); else el.setAttribute(a, attrs[a]);
        }
      }
      touchedAttr.clear();
      document.querySelectorAll('[data-tbrub-ann]').forEach((el) => el.removeAttribute('data-tbrub-ann'));
      stats.done = 0;
    }
 
    return {
      start, stop, scan,
      isOwnWrite: (t) => written.get(t) === t.nodeValue,
      status: () => ({ done: stats.done, queue: waiting.size, errors: stats.errors, active: !!io })
    };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6. УМНЫЙ ПЕРЕВОД ПОИСКА (RU/EN → 中文)
   * ══════════════════════════════════════════════════════════════════════ */
  const SEARCH_INPUT_SEL = [
    'input#q', 'input[name="q"]', 'input[class*="search-suggest-combobox"]', '[class*="search-suggest-combobox"] input',
    'input[class*="search-combobox-input"]', 'input[class*="powerfulQuery"]'
  ].join(',');
  const GLOBAL_BTN_SEL = '.search-suggest-button-0,.search-suggest-button-single,button.btn-search,button[class*="searchBtn--"],[data-sg-type="button"]';
  const SHOP_BTN_SEL = '.search-suggest-button-1';   // «搜本店» — поиск по магазину: отдаём Taobao с переведённым текстом
  const ANY_BTN_SEL = GLOBAL_BTN_SEL + ',' + SHOP_BTN_SEL + ',button,[type="submit"],[role="button"],[class*="search-button"],[class*="btn-search"]';
 
  const Search = (() => {
    const cache = (() => { const c = store.get('zhCache', {}); return c && typeof c === 'object' ? c : {}; })();
    let busy = false, swallowEnter = false, bypass = false;
 
    function cacheSet(key, val) {
      cache[key] = val;
      const keys = Object.keys(cache);
      if (keys.length > 300) keys.slice(0, keys.length - 300).forEach((k) => delete cache[k]);
      store.set('zhCache', cache);
    }
 
    async function translateRun(text) {
      const key = text.toLowerCase();
      if (cache[key]) return cache[key];
      let lastErr;
      for (let i = 0; i < 2; i++) {
        try {
          const zh = parseGtx(JSON.parse(await httpReq({ url: gtxUrl('auto', 'zh-CN', text) })));
          if (!zh) throw new Error('empty translation');
          cacheSet(key, zh);
          return zh;
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    }
 
    async function translatePlan(plan) {
      let ok = 0;
      const out = await Promise.all(plan.parts.map(async (p) => {
        if (p.keep) return p.text;
        try { const zh = cleanZh(await translateRun(p.text)); ok++; return zh; } catch (_) { return p.text; }
      }));
      if (!ok) throw new Error('translation failed');
      return out.join(' ').replace(/\s+/g, ' ').trim();
    }
 
    function navigateGlobal(q) {
      const host = location.hostname;
      let tab = '';
      if (/(^|\.)tmall\.com$/.test(host)) tab = 'mall';
      else if (host === 's.taobao.com') tab = new URLSearchParams(location.search).get('tab') || '';
      location.assign('https://s.taobao.com/search?q=' + encodeURIComponent(q) +
        '&commend=all&search_type=item&ie=utf8' + (tab ? '&tab=' + encodeURIComponent(tab) : ''));
    }
 
    function setNativeValue(input, v) {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(input, v); else input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
 
    /** Поиск по магазину / нестандартная вкладка: подставляем китайский текст и повторяем действие Taobao. */
    function nativeSubmit(input, zh, trigger) {
      setNativeValue(input, zh);
      bypass = true;
      try {
        if (trigger && trigger.isConnected && trigger.tagName !== 'INPUT') trigger.click();
        else {
          const f = input.form || input.closest('form');
          if (f && f.requestSubmit) f.requestSubmit();
          else if (f) f.submit();
        }
      } finally { setTimeout(() => { bypass = false; }, 0); }
    }
 
    function isSearchInput(el) {
      return !!el && el.tagName === 'INPUT' && !/^(hidden|checkbox|radio|button|submit|file)$/i.test(el.type) && el.matches(SEARCH_INPUT_SEL);
    }
 
    function findInputNear(btn) {
      for (let a = btn, i = 0; a && i < 6; a = a.parentElement, i++) {
        const list = a.querySelectorAll ? Array.from(a.querySelectorAll(SEARCH_INPUT_SEL)).filter(isSearchInput) : [];
        const vis = list.find((x) => x.offsetParent !== null) || list[0];
        if (vis) return vis;
      }
      return null;
    }
 
    function looksLikeSearchButton(el) {
      if (el.matches(GLOBAL_BTN_SEL) || el.matches(SHOP_BTN_SEL)) return true;
      const meta = [typeof el.className === 'string' ? el.className : '', el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ');
      if (/clear|close|reset|delete|cancel|history|image|img|camera|photo|upload|voice|mic|拍照|图片|清除|删除/i.test(meta)) return false;
      if (el.type === 'submit') return true;
      if (/search|submit|搜索/i.test(meta)) return true;
      return /^(搜索|search|поиск|найти)$/i.test((el.textContent || '').trim());
    }
 
    /** Нужен ли «родной» путь Taobao (поиск по магазину, вкладка «店铺» и т.п.). */
    function needsNative(input, trigger) {
      if (trigger && trigger.closest && trigger.closest(SHOP_BTN_SEL)) return true;
      const box = input.closest('.search-suggest,#J_Search');
      const tab = box && box.querySelector('.search-suggest-tabs-tab.selected');
      const val = tab && tab.getAttribute('data-value');
      return !!(val && val !== 'item');
    }
 
    function intercept(e, input, trigger) {
      if (bypass || !state.searchTr) return false;
      const value = (input.value || '').trim();
      if (!value) return false;
      const plan = buildPlan(value);
      if (!plan.runs) return false;            // переводить нечего — штатный поиск
      e.preventDefault();
      e.stopImmediatePropagation();
      if (busy) return true;
      busy = true;
      const prevCursor = input.style.cursor;
      input.style.cursor = 'progress';
      const native = needsNative(input, trigger);
      translatePlan(plan)
        .catch((err) => { console.warn('[tb-rub] перевод запроса не удался:', err); return null; })
        .then((zh) => {
          busy = false;
          input.style.cursor = prevCursor;
          const q = zh || value;
          toast(zh ? '🔎 ' + value + ' → ' + zh : 'Перевод не удался, ищу как есть: ' + value);
          if (native) nativeSubmit(input, q, trigger); else navigateGlobal(q);
        });
      return true;
    }
 
    function install() {
      const target = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        const t = target(e);
        if (isSearchInput(t) && intercept(e, t, null)) swallowEnter = true;
      }, true);
      ['keypress', 'keyup'].forEach((type) => {
        document.addEventListener(type, (e) => {
          if (!swallowEnter || e.key !== 'Enter') return;
          e.stopImmediatePropagation(); e.preventDefault();
          if (type === 'keyup') swallowEnter = false;
        }, true);
      });
      document.addEventListener('submit', (e) => {
        const f = e.target;
        const inp = f && f.querySelector && f.querySelector(SEARCH_INPUT_SEL);
        if (inp && isSearchInput(inp)) intercept(e, inp, null);
      }, true);
      document.addEventListener('click', (e) => {
        const t = target(e);
        const btn = t && t.closest && t.closest(ANY_BTN_SEL);
        if (!btn || btn.closest('#tbrub-root') || !looksLikeSearchButton(btn)) return;
        const inp = findInputNear(btn);
        if (inp) intercept(e, inp, btn);
      }, true);
    }
 
    return { install };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6½. ПЕРЕВОД ТЕКСТА НА КАРТИНКАХ
   *  Кнопки поверх картинки при наведении: открывают оригинал в полном размере в Google Lens
   *  (вкладка «Перевести») или в Яндекс Картинках (блок «Текст на картинке» → перевод).
   * ══════════════════════════════════════════════════════════════════════ */
  const ImgTr = (() => {
    const MIN_SIDE = 140;
    // Миниатюры-карточки (ссылка на товар): наша кнопка над ними уводит курсор с карточки, Taobao на каждый
    // повторный заход мыши шлёт запрос (mtop) — поэтому на карточках кнопок нет, только на фото товара/описания.
    const CARD_LINK_SEL = 'a[href*="item.taobao.com"],a[href*="detail.tmall.com"],a[href*="item.htm"],a[href*="click.simba"],' +
      'a[href*="detail.taobao.com"],a[href*="world.taobao.com/item"],[class*="doubleCard"],[class*="Card--"]';
    let wrap = null, cur = null, last = 0, btnHere = null;
 
    /** Полноразмерный URL: alicdn-миниатюры имеют хвост вида «.jpg_760x760q30.jpg_.webp». */
    function fullUrl(src) {
      let u = src || '';
      if (!u || /^(data|blob):/i.test(u)) return null;
      if (u.startsWith('//')) u = 'https:' + u;
      u = u.replace(/(\.(?:jpe?g|png|gif|webp))_[^/?#]*$/i, '$1');
      return /^https?:\/\//i.test(u) ? u : null;
    }
 
    /** Реально показанный адрес; при сбое srcset — атрибут src или ленивый data-src. */
    function imgSrc(el) {
      const c = el.currentSrc;
      if (c && /^(https?:)?\/\//i.test(c)) return c;
      return el.getAttribute('src') || el.getAttribute('data-src') || el.src || '';
    }
 
    /** Подходит ли картинка для перевода: не миниатюра-карточка, достаточно крупная, с нормальным адресом. */
    function eligible(el, minW, minH) {
      if (!el || el.tagName !== 'IMG' || el.closest(CARD_LINK_SEL)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= (minW || MIN_SIDE) && r.height >= (minH || MIN_SIDE) && !!fullUrl(imgSrc(el));
    }
 
    function pick(x, y) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (el.closest && el.closest('#tbrub-imgbtn,#tbrub-root')) return 'self';
        if (el.tagName === 'IMG') return eligible(el) ? el : null;
      }
      return null;
    }
 
    function open(kind) {
      if (!cur) return;
      if (kind === 'here') { ImgOcr.toggle(cur); refresh(); return; }
      const u = encodeURIComponent(fullUrl(imgSrc(cur)));
      const href = kind === 'google'
        ? 'https://lens.google.com/uploadbyurl?url=' + u + '&hl=ru'
        : 'https://yandex.ru/images/search?rpt=imageview&url=' + u;
      window.open(href, '_blank', 'noopener');
    }
 
    function ensure() {
      if (wrap) return wrap;
      wrap = document.createElement('div');
      wrap.id = 'tbrub-imgbtn';
      wrap.className = 'notranslate';
      wrap.setAttribute('translate', 'no');
      const mkb = (text, title, kind) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = text; b.title = title;
        // перехватываем раньше страницы: под картинкой часто ссылка на товар или зум галереи
        ['pointerdown', 'mousedown', 'mouseup'].forEach((t) => b.addEventListener(t, (e) => { e.stopPropagation(); }, true));
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(kind); }, true);
        return b;
      };
      btnHere = mkb('🖼 Перевод на фото', 'Перевести текст прямо поверх картинки (распознавание: движок из панели скрипта)', 'here');
      wrap.append(
        btnHere,
        mkb('🔤 Lens', 'Открыть картинку в Google Lens (там выберите «Перевести»)', 'google'),
        mkb('Я', 'Открыть картинку в Яндексе: «Текст на картинке» → перевод', 'yandex')
      );
      document.body.appendChild(wrap);
      return wrap;
    }
 
    function refresh() {
      if (!btnHere) return;
      btnHere.textContent = !cur ? '🖼 Перевод на фото' : ImgOcr.busy(cur) ? '⏳ Перевожу…' : ImgOcr.has(cur) ? '↩ Оригинал' : '🖼 Перевод на фото';
    }
 
    function place(img) {
      const w = ensure();
      const r = img.getBoundingClientRect();
      cur = img;
      refresh();
      w.style.display = 'flex';
      const left = Math.min(window.innerWidth - w.offsetWidth - 6, Math.max(6, r.right - w.offsetWidth - 8));
      w.style.left = left + 'px';
      w.style.top = Math.max(6, r.top + 8) + 'px';
      cur = img;
    }
 
    function hide() { if (wrap) wrap.style.display = 'none'; cur = null; }
 
    function onMove(e) {
      if (!state.imgTr) return;
      const now = performance.now();
      if (now - last < 80) return;
      last = now;
      const t = pick(e.clientX, e.clientY);
      if (t === 'self') return;
      if (t) place(t); else hide();
    }
 
    function install() {
      document.addEventListener('mousemove', onMove, { passive: true, capture: true });
      window.addEventListener('scroll', hide, { passive: true, capture: true });
      document.addEventListener('mouseleave', hide);
    }
 
    return { install, hide, fullUrl, imgSrc, refresh, eligible };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6⅝. ДВИЖКИ РАСПОЗНАВАНИЯ ТЕКСТА НА КАРТИНКАХ (без ключей — прямо в браузере)
   *  PaddleOCR (PP-OCRv4, ONNX Runtime Web/WebAssembly) и Tesseract.js (chi_sim).
   *  Библиотеки и модели качаются с CDN один раз (≈27 МБ / ≈5 МБ) и хранятся в IndexedDB сайта.
   *  Код библиотек грузится только при первом использовании, на остальных страницах ничего не весит.
   * ══════════════════════════════════════════════════════════════════════ */
  const CDN_BASES = ['https://cdn.jsdelivr.net/npm/', 'https://fastly.jsdelivr.net/npm/', 'https://unpkg.com/'];
  const ORT_PKG = 'onnxruntime-web@1.18.0/dist/';
  const PADDLE_PKG = '@gutenye/ocr-models@1.4.2/assets/';
  const TESS_PKG = 'tesseract.js@5.1.1/dist/tesseract.min.js';
  const ENGINE_NAMES = { paddle: 'PaddleOCR', tesseract: 'Tesseract', vision: 'Google Vision' };
 
  const OcrEngines = (() => {
    const status = { paddle: '', tesseract: '' };     // '' — не загружался, 'ok', 'loading' или текст ошибки
    const mb = (n) => (n / 1048576).toFixed(1);
 
    // ── IndexedDB: кэш библиотек и моделей ──
    let dbp = null;
    function idb() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          const r = indexedDB.open('tbrub-ocr', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('files');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        dbp.catch(() => { dbp = null; });
      }
      return dbp;
    }
    async function idbGet(k) {
      try {
        const db = await idb();
        return await new Promise((res) => {
          const q = db.transaction('files').objectStore('files').get(k);
          q.onsuccess = () => res(q.result || null);
          q.onerror = () => res(null);
        });
      } catch (_) { return null; }
    }
    async function idbPut(k, v) {
      try {
        const db = await idb();
        await new Promise((res) => {
          const tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').put(v, k);
          tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
        });
      } catch (_) { /* кэш не обязателен */ }
    }
 
    function get(url, type, onProgress) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return type === 'text' ? r.text() : r.arrayBuffer(); })
            .then(resolve, reject);
          return;
        }
        GM_xmlhttpRequest({
          method: 'GET', url, responseType: type === 'text' ? 'text' : 'arraybuffer', timeout: 240000,
          onprogress: (e) => { if (onProgress && e && e.loaded) onProgress(e.loaded, e.total || 0); },
          onload: (r) => (r.status >= 200 && r.status < 300
            ? resolve(type === 'text' ? r.responseText : r.response)
            : reject(new Error('HTTP ' + r.status + ' ' + url))),
          onerror: () => reject(new Error('нет связи с ' + url.split('/')[2])),
          ontimeout: () => reject(new Error('таймаут ' + url.split('/')[2]))
        });
      });
    }
 
    let okBase = CDN_BASES[0];                         // зеркало, которое последним ответило
 
    /** Файл пакета npm с CDN (зеркала по очереди) с кэшем в IndexedDB. */
    async function cdnFile(path, type, label) {
      const key = 'v1:' + path;
      const cached = await idbGet(key);
      if (cached) return cached;
      let err = null;
      for (const base of CDN_BASES) {
        try {
          let lastT = 0;
          const data = await get(base + path, type, (l, t) => {
            const now = Date.now();
            if (now - lastT < 300) return;
            lastT = now;
            toast('⏳ Загрузка (один раз): ' + label + ' — ' + mb(l) + (t ? ' из ' + mb(t) : '') + ' МБ', 60000);
          });
          if (type === 'text' ? !data || data.length < 20 : !data || data.byteLength < 1000) throw new Error('пустой ответ CDN');
          idbPut(key, data);
          okBase = base;
          return data;
        } catch (e) { err = e; console.warn('[tb-rub] OCR: не скачался ' + base + path, e); }
      }
      throw err || new Error('не удалось скачать ' + label);
    }
 
    /** Выполняет UMD-библиотеку в песочнице скрипта (AMD страницы не мешает) и возвращает её экспорт. */
    function evalLib(code, name) {
      const module = { exports: {} };
      // eslint-disable-next-line no-new-func
      const fn = new Function('module', 'exports', 'define', code + '\n//# sourceURL=tbrub-' + name + '.js');
      fn.call(window, module, module.exports, undefined);
      const ex = module.exports;
      if (ex && (ex.InferenceSession || ex.createWorker)) return ex;
      if (ex && ex[name]) return ex[name];
      return (typeof self !== 'undefined' && self[name]) || window[name] || null;
    }
 
    const whiteCanvas = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, w, h);
      return { c, cx };
    };
 
    // ── PaddleOCR (PP-OCRv4: детектор DBNet + распознаватель CRNN/CTC) ──
    let paddleP = null;
    function paddleInit() {
      if (paddleP) return paddleP;
      status.paddle = 'loading';
      paddleP = (async () => {
        const lib = await cdnFile(ORT_PKG + 'ort.wasm-core.min.js', 'text', 'ONNX Runtime');
        const wasm = await cdnFile(ORT_PKG + 'ort-wasm-simd.wasm', 'bin', 'ONNX Runtime (wasm)');
        const det = await cdnFile(PADDLE_PKG + 'ch_PP-OCRv4_det_infer.onnx', 'bin', 'модель поиска текста');
        const rec = await cdnFile(PADDLE_PKG + 'ch_PP-OCRv4_rec_infer.onnx', 'bin', 'модель иероглифов');
        const keys = await cdnFile(PADDLE_PKG + 'ppocr_keys_v1.txt', 'text', 'словарь');
        toast('⏳ PaddleOCR: запуск…', 60000);
        let lastErr = null;
        // wasm: сначала из нашего кэша (blob:), при отказе — напрямую с CDN (новый экземпляр библиотеки)
        for (const mode of ['blob', 'cdn']) {
          try {
            const ort = evalLib(lib, 'ort');
            if (!ort || !ort.InferenceSession) throw new Error('ONNX Runtime не инициализировался');
            ort.env.wasm.numThreads = 1;              // без воркеров и SharedArrayBuffer
            ort.env.wasm.proxy = false;
            ort.env.wasm.simd = true;
            if (mode === 'blob') {
              const u = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
              ort.env.wasm.wasmPaths = { 'ort-wasm-simd.wasm': u, 'ort-wasm.wasm': u };
            } else ort.env.wasm.wasmPaths = okBase + ORT_PKG;
            const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
            const sDet = await ort.InferenceSession.create(new Uint8Array(det), opt);
            const sRec = await ort.InferenceSession.create(new Uint8Array(rec), opt);
            status.paddle = 'ok';
            return { ort, sDet, sRec, keys, chars: null };
          } catch (e) { lastErr = e; console.warn('[tb-rub] PaddleOCR: запуск (' + mode + ') не удался', e); }
        }
        throw lastErr;
      })();
      paddleP.catch((e) => { paddleP = null; status.paddle = String((e && e.message) || e).slice(0, 140); });
      return paddleP;
    }
 
    async function paddleDetect(P, src, W, H) {
      const lines = [];
      const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];   // порядок каналов BGR, как в PaddleOCR
      for (const t of tilesFor(W, H)) {
        const th = t.y1 - t.y0;
        const scale = Math.min(1, 960 / Math.max(W, th));
        const w = Math.max(32, Math.round((W * scale) / 32) * 32), h = Math.max(32, Math.round((th * scale) / 32) * 32);
        const { cx } = whiteCanvas(w, h);
        cx.drawImage(src, 0, t.y0, W, th, 0, 0, w, h);
        const px = cx.getImageData(0, 0, w, h).data;
        const n = w * h, f = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) {
          const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
          f[i] = (b - mean[0]) / std[0];
          f[n + i] = (g - mean[1]) / std[1];
          f[2 * n + i] = (r - mean[2]) / std[2];
        }
        const out = await P.sDet.run({ [P.sDet.inputNames[0]]: new P.ort.Tensor('float32', f, [1, 3, h, w]) });
        const o = out[P.sDet.outputNames[0]];
        const oh = o.dims[o.dims.length - 2], ow = o.dims[o.dims.length - 1];
        const sx = W / ow, sy = th / oh;
        for (const b of detBoxes(o.data, ow, oh)) {
          const y0 = t.y0 + b.y0 * sy, y1 = t.y0 + b.y1 * sy, cy = (y0 + y1) / 2;
          if (cy < t.k0 || cy >= t.k1) continue;                      // строку из перекрытия считает одна полоса
          lines.push({ x0: b.x0 * sx, y0, x1: b.x1 * sx, y1 });
        }
      }
      return lines;
    }
 
    async function paddleRecLine(P, src, L) {
      const w = L.x1 - L.x0, h = L.y1 - L.y0;
      const vertical = h >= w * 1.5;                                  // вертикальная строка: поворот на 90° против часовой
      const RH = 48;
      const RW = Math.max(16, Math.min(2400, Math.ceil((RH * (vertical ? h : w)) / (vertical ? w : h))));
      const { cx } = whiteCanvas(RW, RH);
      if (vertical) { cx.translate(0, RH); cx.rotate(-Math.PI / 2); cx.drawImage(src, L.x0, L.y0, w, h, 0, 0, RH, RW); }
      else cx.drawImage(src, L.x0, L.y0, w, h, 0, 0, RW, RH);
      const px = cx.getImageData(0, 0, RW, RH).data;
      const n = RW * RH, f = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        f[i] = px[i * 4 + 2] / 127.5 - 1;
        f[n + i] = px[i * 4 + 1] / 127.5 - 1;
        f[2 * n + i] = px[i * 4] / 127.5 - 1;
      }
      const out = await P.sRec.run({ [P.sRec.inputNames[0]]: new P.ort.Tensor('float32', f, [1, 3, RH, RW]) });
      const o = out[P.sRec.outputNames[0]];
      const T = o.dims[1], C = o.dims[2];
      if (!P.chars || P.chars.length < C) P.chars = ctcChars(P.keys, C);
      return ctcDecode(o.data, T, C, P.chars);
    }
 
    async function paddle(src, W, H) {
      const P = await paddleInit();
      const boxes = await paddleDetect(P, src, W, H);
      const lines = [];
      for (let i = 0; i < boxes.length; i++) {
        if (i % 4 === 0) toast('⏳ PaddleOCR: строка ' + (i + 1) + ' из ' + boxes.length + '…', 60000);
        const r = await paddleRecLine(P, src, boxes[i]);
        const text = r.text.trim();
        if (text && r.score >= 0.5) lines.push(Object.assign({ text }, boxes[i]));
      }
      return mergeLines(lines).map((b) => ({ text: tidyOcrText(b.text), verts: rectVerts(b.x0, b.y0, b.x1, b.y1) }));
    }
 
    // ── Tesseract.js (chi_sim) ──
    let tessP = null;
    function tessInit() {
      if (tessP) return tessP;
      status.tesseract = 'loading';
      tessP = (async () => {
        const code = await cdnFile(TESS_PKG, 'text', 'Tesseract.js');
        const T = evalLib(code, 'Tesseract');
        if (!T || !T.createWorker) throw new Error('Tesseract.js не инициализировался');
        toast('⏳ Tesseract: загрузка ядра и модели chi_sim (≈5 МБ, кэшируется браузером)…', 90000);
        const worker = await T.createWorker('chi_sim', 1, {
          errorHandler: (e) => console.warn('[tb-rub] Tesseract:', e)
        });
        status.tesseract = 'ok';
        return worker;
      })();
      tessP.catch((e) => { tessP = null; status.tesseract = String((e && e.message) || e).slice(0, 140); });
      return tessP;
    }
 
    async function tesseract(src) {
      const worker = await tessInit();
      const blob = await new Promise((res) => src.toBlob(res, 'image/png'));
      const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
      const lines = [];
      const push = (l) => {
        if (!l || !l.bbox) return;
        const text = tidyOcrText(l.text || '');
        if (!text || (typeof l.confidence === 'number' && l.confidence < 45)) return;
        lines.push({ text, x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 });
      };
      for (const b of (data && data.blocks) || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) push(l);
      if (!lines.length && data && data.lines) data.lines.forEach(push);
      return mergeLines(lines).map((b) => ({ text: tidyOcrText(b.text), verts: rectVerts(b.x0, b.y0, b.x1, b.y1) }));
    }
 
    /** Проверка: загружает и запускает движок на маленькой тестовой картинке. */
    async function check(name) {
      const { c, cx } = whiteCanvas(240, 64);
      cx.fillStyle = '#000';
      cx.font = '40px sans-serif';
      cx.fillText('测试', 70, 46);
      const res = name === 'paddle' ? await paddle(c, 240, 64) : await tesseract(c);
      return res.map((b) => b.text).join(' ');
    }
 
    return { paddle, tesseract, check, status };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6¾. ПЕРЕВОД ТЕКСТА ПРЯМО НА КАРТИНКЕ (по клику)
   *  Картинка скачивается через GM_xmlhttpRequest (без CORS) → распознавание (PaddleOCR / Tesseract / Google Vision)
   *  → Google Translate → поверх картинки рисуется слой: плашка цвета фона + русский текст по месту оригинала.
   *  Результат кэшируется (память + хранилище), повторный показ не тратит запросы Vision.
   * ══════════════════════════════════════════════════════════════════════ */
  const ImgOcr = (() => {
    const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate?key=';
    const VISION_FEATURE = 'TEXT_DETECTION';
    const CACHE_KEY = 'ocrCache1';
    const CACHE_MAX = 80;
    const overlays = new Map();        // img → {src, root, g, W, H}
    const inflight = new Set();
    const memory = new Map();          // url → результат
    let persisted = store.get(CACHE_KEY, {});
    if (!persisted || typeof persisted !== 'object') persisted = {};
    let raf = 0, frame = 0;
 
    const KEY_HELP =
      'Для перевода текста на картинке нужен ключ Google Cloud Vision API.\n' +
      'Бесплатно: 1000 картинок в месяц (дальше ≈ $1,5 за 1000).\n\n' +
      '1) console.cloud.google.com → создайте проект и привяжите платёжный аккаунт\n' +
      '2) «APIs & Services» → включите Cloud Vision API\n' +
      '3) «Credentials» → Create credentials → API key\n' +
      '   Ограничьте ключ по API (только Cloud Vision). Ограничение по сайтам (HTTP referrer) НЕ ставьте — оно блокирует запросы скрипта.\n\n' +
      'Вставьте ключ (пустая строка — удалить):';
 
    function askKey() {
      const v = window.prompt(KEY_HELP, state.visionKey || '');
      if (v === null) return false;
      state.visionKey = v.trim();
      store.set('visionKey', state.visionKey);
      Ui.render();
      return !!state.visionKey;
    }
 
    function fetchBytes(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'GET', url, responseType: 'arraybuffer', timeout: 25000,
            onload: (r) => (r.status >= 200 && r.status < 300 && r.response ? resolve(new Uint8Array(r.response)) : reject(new Error('HTTP ' + r.status))),
            onerror: () => reject(new Error('network error')),
            ontimeout: () => reject(new Error('timeout'))
          });
        } else {
          fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
            .then((b) => resolve(new Uint8Array(b)), reject);
        }
      });
    }
 
    const absUrl = (u) => (u && u.startsWith('//') ? 'https:' + u : (u || '').replace(/^http:/i, 'https:'));
 
    /** Сначала оригинал в полном размере, при неудаче — тот адрес, что реально на странице. */
    function candidates(img) {
      const src = ImgTr.imgSrc(img);
      return Array.from(new Set([ImgTr.fullUrl(src), absUrl(src)].filter((u) => u && /^https?:/i.test(u))));
    }
 
    async function download(cands) {
      let lastErr = new Error('Не удалось скачать картинку');
      for (const u of cands) {
        try {
          const bytes = await fetchBytes(u);
          if (bytes.length > 200 && sniffMime(bytes)) return { url: u, bytes };
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    }
 
    /** Картинка → canvas нужного размера и байты для Vision (при большом размере — пережимаем в JPEG). */
    /** Картинка → canvas (белая подложка) и, для Vision, байты ≤ лимита запроса (иначе пережимаем в JPEG). */
    async function prepare(bytes, forVision) {
      const mime = sniffMime(bytes);
      const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
      let W = bmp.width, H = bmp.height, send = bytes, ctx;
      const canvas = document.createElement('canvas');
      const draw = (w, h) => {
        canvas.width = w; canvas.height = h;
        ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
      };
      if (forVision && bytes.length > OCR_MAX_BYTES) {
        let scale = Math.min(1, 3500 / Math.max(W, H));
        for (let i = 0; i < 4; i++) {
          W = Math.max(1, Math.round(bmp.width * scale)); H = Math.max(1, Math.round(bmp.height * scale));
          draw(W, H);
          const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
          send = new Uint8Array(await blob.arrayBuffer());
          if (send.length <= OCR_MAX_BYTES) break;
          scale *= 0.75;
        }
      } else if (!forVision && W > 2400) {
        H = Math.round((H * 2400) / W); W = 2400;
        draw(W, H);
      } else draw(W, H);
      if (bmp.close) bmp.close();
      return { W, H, send, ctx };
    }
 
    async function callVision(send) {
      const body = JSON.stringify({ requests: [{ image: { content: bytesToBase64(send) }, features: [{ type: VISION_FEATURE }] }] });
      const txt = await httpReq({
        method: 'POST', url: VISION_URL + encodeURIComponent(state.visionKey),
        headers: { 'Content-Type': 'application/json' }, data: body, timeout: 40000
      });
      const r = (JSON.parse(txt).responses || [])[0] || {};
      if (r.error) throw Object.assign(new Error(r.error.message || 'Vision error'), { visionCode: r.error.code });
      return r;
    }
 
    /** Пачка фраз zh → ru: сначала словарь, остальное — Google (батчи, при склейке строк делим пополам). */
    async function translateMany(list) {
      const out = new Map();
      const todo = [];
      for (const t of list) { const l = localTranslate(t); if (l !== null) out.set(t, l); else todo.push(t); }
      async function run(items) {
        if (!items.length) return;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const data = JSON.parse(await httpReq({ url: gtxUrl('zh-CN', TL, items.map(prepForGoogle).join('\n')), timeout: 12000 }));
            const joined = parseGtx(data);
            const parts = items.length === 1 ? [joined.trim()] : splitGtx(joined, items.length);
            if (parts) { items.forEach((t, i) => { if (parts[i]) out.set(t, parts[i]); }); return; }
            break;                                              // Google склеил строки → делим
          } catch (e) { if (attempt === 1) return; }
        }
        if (items.length === 1) return;
        const mid = Math.ceil(items.length / 2);
        await run(items.slice(0, mid)); await run(items.slice(mid));
      }
      for (const batch of buildBatches(todo, 3000)) await run(batch);
      return out;
    }
 
    /** Цвет фона: медиана пикселей в узком кольце вокруг рамки текста. */
    function ringColor(ctx, W, H, x0, y0, x1, y1) {
      const t = 3, R = [], G = [], B = [];
      const rects = [[x0 - t, y0 - t, x1 + t, y0], [x0 - t, y1, x1 + t, y1 + t], [x0 - t, y0, x0, y1], [x1, y0, x1 + t, y1]];
      for (const rc of rects) {
        const a = Math.max(0, Math.floor(rc[0])), b = Math.max(0, Math.floor(rc[1]));
        const c = Math.min(W, Math.ceil(rc[2])), d = Math.min(H, Math.ceil(rc[3]));
        if (c - a < 1 || d - b < 1) continue;
        const px = ctx.getImageData(a, b, c - a, d - b).data;
        for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 127) { R.push(px[i]); G.push(px[i + 1]); B.push(px[i + 2]); }
      }
      return R.length ? [median(R), median(G), median(B)].map(Math.round) : [240, 240, 240];
    }
 
    function describeError(e) {
      if (e && e.engine && e.engine !== 'vision') {
        return ENGINE_NAMES[e.engine] + ' не запустился: ' + String(e.message || e).slice(0, 160) +
          '. Выберите другой движок в панели (плашка курса) или нажмите там «Проверить движки».';
      }
      let msg = '';
      try { msg = (JSON.parse(e.body || '{}').error || {}).message || ''; } catch (_) { /* ignore */ }
      msg = msg || e.message || String(e);
      if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Ключ Google Vision недействителен — задайте новый в панели (плашка курса → «Ключ…»).';
      if (e.status === 403 || e.visionCode === 403 || /PERMISSION_DENIED|billing|not been used|disabled/i.test(msg)) {
        return 'Vision отказал в доступе: включите Cloud Vision API и платёжный аккаунт в проекте, ключ не ограничивайте по сайтам. ' + msg.slice(0, 110);
      }
      if (e.status === 429 || e.visionCode === 429) return 'Превышена квота Google Vision.';
      if (/network error|timeout/i.test(msg)) return 'Нет связи с сервером (' + msg + '). Проверьте @connect-разрешения скрипта.';
      return msg.slice(0, 200);
    }
 
    function persist(url, res) {
      persisted[url] = { t: Date.now(), W: res.W, H: res.H, b: res.b, eng: res.eng };
      const keys = Object.keys(persisted);
      if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => persisted[a].t - persisted[b].t).slice(0, keys.length - CACHE_MAX).forEach((k) => delete persisted[k]);
      }
      store.set(CACHE_KEY, persisted);
    }
 
    /** Порядок движков: выбранный в панели или «Авто» (локальные → Vision, если задан ключ; в автопереводе — без Vision). */
    function engineOrder(quiet) {
      if (state.ocrEngine !== 'auto') return [state.ocrEngine];
      return ['paddle', 'tesseract'].concat(state.visionKey && !quiet ? ['vision'] : []);
    }
    const cacheKey = (eng, u) => (eng === 'vision' ? u : eng + '|' + u);      // старые записи кэша — от Vision
 
    function fromCache(engs, cands) {
      for (const eng of engs) {
        for (const u of cands) {
          const k = cacheKey(eng, u);
          if (memory.has(k)) return memory.get(k);
          if (persisted[k]) { memory.set(k, persisted[k]); return persisted[k]; }
        }
      }
      return null;
    }
 
    async function runEngine(eng, bytes, quiet) {
      if (eng === 'vision') {
        if (!state.visionKey) throw new Error('не задан ключ Google Vision');
        const p = await prepare(bytes, true);
        if (!quiet) toast('⏳ Распознаю текст (Google Vision)…', 40000);
        return { W: p.W, H: p.H, ctx: p.ctx, blocks: visionToBlocks(await callVision(p.send)) };
      }
      const p = await prepare(bytes, false);
      if (!quiet) toast('⏳ Распознаю текст (' + ENGINE_NAMES[eng] + ', на вашем компьютере)…', 120000);
      const blocks = eng === 'paddle' ? await OcrEngines.paddle(p.ctx.canvas, p.W, p.H) : await OcrEngines.tesseract(p.ctx.canvas);
      return { W: p.W, H: p.H, ctx: p.ctx, blocks };
    }
 
    /** Полный конвейер для картинки → результат {W,H,b:[…]} (из кэша или через движок OCR). */
    async function recognize(img, quiet) {
      const cands = candidates(img);
      if (!cands.length) throw new Error('Не удалось определить адрес картинки');
      const engs = engineOrder(quiet);
      const hit = fromCache(engs, cands);
      if (hit) return hit;
      if (engs.length === 1 && engs[0] === 'vision' && !state.visionKey && !askKey()) {
        throw Object.assign(new Error('Нужен ключ Google Vision'), { silent: true });
      }
 
      if (!quiet) toast('⏳ Скачиваю картинку…', 20000);
      const { url, bytes } = await download(cands);
      let got = null, lastErr = null;
      for (const eng of engs) {
        try { got = await runEngine(eng, bytes, quiet); got.eng = eng; break; } catch (e) {
          lastErr = Object.assign(e, { engine: eng });
          console.warn('[tb-rub] OCR ' + eng + ':', e);
          if (engs.length > 1 && !quiet) toast('⚠ ' + ENGINE_NAMES[eng] + ' не сработал — пробую следующий движок…', 4000);
        }
      }
      if (!got) throw lastErr;
      const { W, H, ctx, eng } = got;
      const raw = got.blocks.filter((b) => CJK_RE.test(b.text));
      const items = raw.map((b) => ({ text: b.text, q: quadInfo(b.verts), verts: b.verts }))
        .filter((x) => x.q.h >= 8 && x.q.w >= 8);
      if (!items.length) throw Object.assign(new Error('Китайский текст на картинке не найден (' + ENGINE_NAMES[eng] + ')'), { silent: true, info: true });
      if (!quiet) toast('⏳ Перевожу ' + items.length + ' фрагм.…', 30000);
      const tr = await translateMany(Array.from(new Set(items.map((x) => x.text))));
      const res = { W, H, b: [], eng };
      for (const it of items) {
        const t = tr.get(it.text);
        if (!t) continue;                                       // не перевелось — оставляем оригинал
        const xs = it.verts.map((p) => p.x), ys = it.verts.map((p) => p.y);
        const pad = Math.max(2, it.q.h * 0.1);
        const bg = ringColor(ctx, W, H, Math.min.apply(null, xs) - pad, Math.min.apply(null, ys) - pad,
          Math.max.apply(null, xs) + pad, Math.max.apply(null, ys) + pad);
        const n = (it.text.match(/[\u3400-\u9fff]/g) || []).length;
        const r1 = (v) => Math.round(v * 10) / 10;
        res.b.push({ tr: t, cx: r1(it.q.cx), cy: r1(it.q.cy), w: r1(it.q.w), h: r1(it.q.h), ang: r1(it.q.ang), n, bg });
      }
      if (!res.b.length) throw Object.assign(new Error('Не удалось перевести текст на картинке'), { silent: true, info: true });
      const k = cacheKey(eng, url);
      memory.set(k, res);
      persist(k, res);
      return res;
    }
 
    /** Подбор размера шрифта, чтобы перевод поместился в рамку (бинарный поиск). */
    function fitFont(el, sp, hi) {
      let lo = 5;
      hi = Math.max(hi, lo);
      let best = lo;
      for (let i = 0; i < 9 && hi - lo > 0.5; i++) {
        const mid = (lo + hi) / 2;
        sp.style.fontSize = mid + 'px';
        if (sp.offsetHeight <= el.clientHeight && sp.scrollWidth <= el.clientWidth + 1) { best = mid; lo = mid; } else hi = mid;   // слова не рвём
      }
      sp.style.fontSize = best + 'px';
      return best;
    }
 
    function removeOverlay(img) {
      const o = overlays.get(img);
      if (!o) return;
      o.root.remove();
      overlays.delete(img);
      ImgTr.refresh();
    }
 
    function posFrac(str) {
      const t = String(str || '50% 50%').split(/\s+/);
      const f = (v) => (v === 'left' || v === 'top' ? 0 : v === 'right' || v === 'bottom' ? 1 : /%$/.test(v) ? parseFloat(v) / 100 : 0.5);
      return [f(t[0]), f(t[1] || t[0])];
    }
 
    /** Накладывает слой на текущее положение/масштаб картинки (учитывает object-fit/object-position). */
    function syncOne(img, o, n) {
      if (!img.isConnected || ImgTr.imgSrc(img) !== o.src) { removeOverlay(img); return; }
      const r = img.getBoundingClientRect();
      const ix0 = Math.max(r.left, 0), iy0 = Math.max(r.top, 0), ix1 = Math.min(r.right, innerWidth), iy1 = Math.min(r.bottom, innerHeight);
      if (r.width < 2 || r.height < 2 || ix1 - ix0 < 2 || iy1 - iy0 < 2) { o.root.style.visibility = 'hidden'; return; }
      const cs = getComputedStyle(img);
      const fit = cs.objectFit;
      const kx = r.width / o.W, ky = r.height / o.H;
      let sx = kx, sy = ky;
      if (fit === 'contain') sx = sy = Math.min(kx, ky);
      else if (fit === 'cover') sx = sy = Math.max(kx, ky);
      else if (fit === 'none') sx = sy = 1;
      else if (fit === 'scale-down') sx = sy = Math.min(1, kx, ky);
      const pos = posFrac(cs.objectPosition);
      const ox = (r.width - o.W * sx) * pos[0], oy = (r.height - o.H * sy) * pos[1];
      const st = o.root.style;
      st.left = r.left + 'px'; st.top = r.top + 'px'; st.width = r.width + 'px'; st.height = r.height + 'px';
      o.g.style.transform = 'translate(' + ox + 'px,' + oy + 'px) scale(' + sx + ',' + sy + ')';
      if (n % 6 === 0 || st.visibility === 'hidden') {                            // перекрыта ли картинка шапкой/окном
        const top = document.elementFromPoint((ix0 + ix1) / 2, (iy0 + iy1) / 2);
        const ok = !top || top === img || (img.parentElement && img.parentElement.contains(top)) ||
          (top.closest && top.closest('#tbrub-root,#tbrub-imgbtn,#tbrub-toast'));
        st.visibility = ok && cs.visibility !== 'hidden' ? 'visible' : 'hidden';
      }
    }
 
    function loop() {
      raf = 0;
      if (!overlays.size) return;
      frame++;
      for (const [img, o] of Array.from(overlays)) syncOne(img, o, frame);
      raf = requestAnimationFrame(loop);
    }
 
    function show(img, res) {
      removeOverlay(img);
      const root = document.createElement('div');
      root.className = 'tbrub-ocr notranslate';
      root.setAttribute('translate', 'no');
      root.style.visibility = 'hidden';
      root.style.zIndex = '999990';
      const g = document.createElement('div');
      g.className = 'tbrub-ocr-g';
      g.style.width = res.W + 'px';
      g.style.height = res.H + 'px';
      root.appendChild(g);
      document.body.appendChild(root);
      for (const b of res.b) {
        const el = document.createElement('div');
        el.className = 'tbrub-ocr-b';
        const sp = document.createElement('span');
        sp.textContent = b.tr;
        el.appendChild(sp);
        el.style.background = 'rgb(' + b.bg.join(',') + ')';
        el.style.color = textColorFor(b.bg);
        g.appendChild(el);
        const pad = Math.max(2, b.h * 0.1);
        const fo = Math.min(b.h, Math.sqrt((b.w * b.h) / Math.max(1, b.n)));      // оценка исходного кегля
        for (const [kw, kh] of [[1, 1], [1.3, 1.2], [1.6, 1.5], [1.9, 1.8]]) {
          const bw = Math.min((b.w + 2 * pad) * kw, res.W), bh = Math.min((b.h + 2 * pad) * kh, res.H);
          let left = b.cx - bw / 2, top = b.cy - bh / 2;
          if (!b.ang) { left = Math.max(0, Math.min(res.W - bw, left)); top = Math.max(0, Math.min(res.H - bh, top)); }
          el.style.left = left + 'px'; el.style.top = top + 'px';
          el.style.width = bw + 'px'; el.style.height = bh + 'px';
          el.style.transform = 'rotate(' + (b.ang || 0) + 'deg)';
          const f = fitFont(el, sp, Math.min(bh, fo * 1.25));
          if (f >= fo * 0.62) break;                              // читаемо — расширять рамку не нужно
        }
      }
      overlays.set(img, { src: ImgTr.imgSrc(img), root, g, W: res.W, H: res.H });
      syncOne(img, overlays.get(img), 0);
      if (!raf) raf = requestAnimationFrame(loop);
    }
 
    async function toggle(img, quiet) {
      if (!img) return;
      if (overlays.has(img)) { if (!quiet) removeOverlay(img); return; }
      if (inflight.has(img)) return;
      inflight.add(img);
      ImgTr.refresh();
      try {
        const res = await recognize(img, quiet);
        if (img.isConnected) show(img, res);
        toast((quiet ? '🖼 Фото переведено: ' : 'Переведено фрагментов: ') + res.b.length +
          (res.eng ? ' · ' + ENGINE_NAMES[res.eng] : '') + (quiet ? '' : ' · «↩ Оригинал» убирает перевод'), quiet ? 1800 : 2600);
      } catch (e) {
        console.warn('[tb-rub] перевод на картинке:', e);
        if (e && e.silent) { if (!quiet) toast(e.info ? e.message : 'Перевод на картинке отменён', e.info ? 3500 : 1500); }
        else toast('⚠ ' + describeError(e), 9000);
      } finally {
        inflight.delete(img);
        ImgTr.refresh();
      }
    }
 
    return {
      toggle, askKey,
      has: (img) => overlays.has(img),
      busy: (img) => inflight.has(img),
      removeAll: () => Array.from(overlays.keys()).forEach(removeOverlay)
    };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6⅞. АВТОПЕРЕВОД ФОТО НА СТРАНИЦЕ ТОВАРА
   *  Крупные фото (галерея, описание) переводятся по очереди, когда попадают на экран. По одной за раз.
   * ══════════════════════════════════════════════════════════════════════ */
  const isItemPage = () => /(^|\.)(item\.taobao|detail\.tmall|detail\.taobao|item\.tmall)\.com$/.test(location.hostname) ||
    /\/item\.htm/.test(location.pathname) || !!document.querySelector('[class*="MainTitle--"],[class*="mainTitle--"]');
 
  const ImgAuto = (() => {
    let io = null, timer = 0, busy = false;
    let seen = new WeakSet();
    const tried = new WeakMap();      // img → src, для которого уже пробовали
    const queue = [];
 
    function onIntersect(entries) {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        seen.delete(e.target);                       // догрузится/сменит src — заметим при следующем обходе
        if (!queue.includes(e.target)) queue.push(e.target);
      }
      pump();
    }
 
    async function pump() {
      if (busy) return;
      busy = true;
      try {
        while (queue.length && state.imgAuto && state.imgTr) {
          const img = queue.shift();
          if (!img.isConnected || ImgOcr.has(img) || ImgOcr.busy(img) || !ImgTr.eligible(img, 260, 120)) continue;
          const src = ImgTr.imgSrc(img);
          if (tried.get(img) === src) continue;
          tried.set(img, src);
          await ImgOcr.toggle(img, true);
        }
      } finally { busy = false; }
    }
 
    function scan() {
      if (!io || document.hidden) return;
      for (const img of document.images) {
        if (seen.has(img) || tried.get(img) === ImgTr.imgSrc(img)) continue;
        seen.add(img);
        io.observe(img);
      }
    }
 
    function start() {
      if (io || !state.imgAuto || !state.imgTr || !document.body || !isItemPage()) return;
      io = new IntersectionObserver(onIntersect, { threshold: 0.35 });
      scan();
      timer = setInterval(scan, 2000);
    }
 
    function stop() {
      if (io) io.disconnect();
      io = null;
      clearInterval(timer);
      queue.length = 0;
      seen = new WeakSet();
    }
 
    return { start, stop };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  7. SPA: общий MutationObserver с дебаунсом, пересчёт при смене SKU
   * ══════════════════════════════════════════════════════════════════════ */
  const Watch = (() => {
    const zones = new Set();
    const trNodes = new Set();
    let timer = 0, firstAt = 0;
 
    const isOwnNode = (n) => (n.nodeType === 1
      ? (n.classList.contains('tb-rub') || n.id === 'tbrub-root' || n.id === 'tbrub-toast' || n.id === 'tbrub-imgbtn' || n.classList.contains('tbrub-ocr'))
      : !!(n.parentElement && n.parentElement.closest('#tbrub-root,#tbrub-toast,#tbrub-imgbtn,.tbrub-ocr,.tb-rub')));
 
    function isOwn(r) {
      const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (t && t.closest('#tbrub-root,#tbrub-toast,#tbrub-imgbtn,.tbrub-ocr,.tb-rub')) return true;
      if (r.type === 'characterData') return Translator.isOwnWrite(r.target);
      const nodes = Array.from(r.addedNodes).concat(Array.from(r.removedNodes));
      return nodes.length > 0 && nodes.every(isOwnNode);
    }
 
    function widen(el) {
      let c = el;
      for (let i = 0; i < 2; i++) {
        const p = c.parentElement;
        if (!p || p === document.body || p === document.documentElement) break;
        c = p;
      }
      return c;
    }
 
    function topmost(list) {
      const s = new Set(list);
      return list.filter((n) => { for (let a = n.parentElement; a; a = a.parentElement) if (s.has(a)) return false; return true; });
    }
 
    function flush() {
      timer = 0; firstAt = 0;
      const z = topmost(Array.from(zones).filter((e) => e.isConnected).map(widen));
      zones.clear();
      if (z.length > 200) Prices.fullScan(); else Prices.scanRoots(z);
      if (state.pageTr) {
        const nodes = Array.from(trNodes);
        trNodes.clear();
        const roots = topmost(nodes.filter((n) => n.isConnected && n.nodeType === 1)).concat(nodes.filter((n) => n.nodeType === 3 && n.isConnected));
        roots.forEach((r) => Translator.scan(r));
      } else trNodes.clear();
    }
 
    function schedule() {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      clearTimeout(timer);
      timer = setTimeout(flush, Math.min(120, Math.max(0, 400 - (now - firstAt))));
    }
 
    function start() {
      new MutationObserver((records) => {
        let dirty = false;
        for (const r of records) {
          if (isOwn(r)) continue;
          dirty = true;
          if (r.type === 'characterData') {
            if (r.target.parentElement) zones.add(r.target.parentElement);
            trNodes.add(r.target);
          } else {
            zones.add(r.target);
            r.addedNodes.forEach((n) => { if (!isOwnNode(n)) { trNodes.add(n); if (n.nodeType === 1) zones.add(n); } });
          }
        }
        if (dirty) schedule();
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
 
      // Клик по варианту SKU: цена обновляется асинхронно → быстрые перепроверки
      document.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('#SkuPanel_tbpcDetail_ssr2025,[class*="sku" i],[class*="valueItem" i]')) {
          [40, 200, 600, 1400].forEach((ms) => setTimeout(() => Prices.fullScan(), ms));
        }
      }, true);
      window.addEventListener('pageshow', () => setTimeout(() => Prices.fullScan(), 200));
      setInterval(() => { if (!document.hidden) Prices.fullScan(); }, 3000);
    }
 
    return { start };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  8. ВИДЖЕТ: плашка курса + всплывающая панель настроек
   * ══════════════════════════════════════════════════════════════════════ */
  const Ui = (() => {
    let els = null;
    let statusTimer = 0;
 
    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const btn = (text, onClick, cls) => {
      const b = mk('button', cls || 'tbrub-b', text);
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
      return b;
    };
    const toggle = (onClick) => btn('', onClick, 'tbrub-t');
 
    function mount() {
      if (document.getElementById('tbrub-root') || !document.body) return;
      const root = mk('div', 'notranslate');
      root.id = 'tbrub-root';
      root.setAttribute('translate', 'no');
 
      const pill = mk('button', 'tbrub-pill');
      pill.type = 'button';
      const dot = mk('span', 'tbrub-dot');
      const pillRate = mk('span', '');
      const pillTr = mk('span', 'tbrub-tag', '文');
      pill.append(dot, pillRate, pillTr);
 
      const panel = mk('div', 'tbrub-panel');
      panel.hidden = true;
      panel.addEventListener('click', (e) => e.stopPropagation());
 
      // курс
      const sRate = mk('div');
      const big = mk('div', 'tbrub-big');
      const src = mk('div', 'tbrub-sub');
      const rateRow = mk('div', 'tbrub-row');
      const bAuto = btn('Авто', () => {
        state.auto = true; state.cnyAutoOn = true;
        store.set('auto', true); store.set('cnyAutoOn', true);
        syncRates(true);
      });
      const bManual = btn('Вручную…', () => {
        const v = window.prompt('Ручной курс: сколько ₽ за 1 ¥?', String(state.manualRate));
        if (v === null) return;
        const r = sanitizeRate(v);
        if (!r) { window.alert('Некорректный курс. Пример: 12.25'); return; }
        state.manualRate = r; state.auto = false;
        store.set('rate', r); store.set('auto', false);
        applyRate();
      });
      const bCny = btn('¥ за USDT…', () => {
        const v = window.prompt('Сколько ¥ даёт 1 USDT? Число — зафиксировать, «auto» — брать из P2P/форекса.',
          state.cnyAutoOn ? 'auto' : String(state.usdtCnyManual));
        if (v === null) return;
        if (/^\s*(auto|авто)\s*$/i.test(v)) { state.cnyAutoOn = true; store.set('cnyAutoOn', true); syncRates(true); return; }
        const r = sanitizeRate(v);
        if (!r || r > 100) { window.alert('Некорректное значение. Пример: 7.2'); return; }
        state.usdtCnyManual = r; state.cnyAutoOn = false; state.auto = true;
        store.set('usdtCny', r); store.set('cnyAutoOn', false); store.set('auto', true);
        syncRates(false);
      });
      const bRefresh = btn('⟳', () => syncRates(true));
      bRefresh.title = 'Обновить курсы сейчас';
      rateRow.append(bAuto, bManual, bCny, bRefresh);
      sRate.append(mk('div', 'tbrub-h', 'Курс'), big, src, rateRow);
 
      // режим цен
      const sMode = mk('div');
      const modeRow = mk('div', 'tbrub-row');
      const setMode = (m) => { state.mode = m; store.set('mode', m); render(); Prices.fullScan(); };
      const bBeside = btn('Рядом: ¥ + ₽', () => setMode('beside'));
      const bReplace = btn('Замена: только ₽', () => setMode('replace'));
      modeRow.append(bBeside, bReplace);
      sMode.append(mk('div', 'tbrub-h', 'Цены'), modeRow);
 
      // перевод
      const sTr = mk('div');
      const rowPage = mk('div', 'tbrub-sw');
      const tPage = toggle(() => {
        state.pageTr = !state.pageTr;
        store.set('pageTr', state.pageTr);
        if (state.pageTr) Translator.start(); else Translator.stop();
        render();
      });
      rowPage.append(mk('span', '', 'Перевод страницы (Google, 中→RU)'), tPage);
      const trStatus = mk('div', 'tbrub-sub');
      const rowSearch = mk('div', 'tbrub-sw');
      const tSearch = toggle(() => { state.searchTr = !state.searchTr; store.set('searchTr', state.searchTr); render(); });
      rowSearch.append(mk('span', '', 'Перевод поиска RU/EN → 中文'), tSearch);
      const rowImg = mk('div', 'tbrub-sw');
      const tImg = toggle(() => {
        state.imgTr = !state.imgTr; store.set('imgTr', state.imgTr);
        if (!state.imgTr) { ImgTr.hide(); ImgOcr.removeAll(); ImgAuto.stop(); } else ImgAuto.start();
        render();
      });
      rowImg.append(mk('span', '', 'Перевод на картинках (кнопки при наведении)'), tImg);
 
      // фото: движок распознавания и автоперевод
      const sImg = mk('div');
      const rowEng = mk('div', 'tbrub-row');
      const engBtns = {};
      [['auto', 'Авто'], ['paddle', 'Paddle'], ['tesseract', 'Tesseract'], ['vision', 'Vision 🔑']].forEach(([k, label]) => {
        engBtns[k] = btn(label, () => {
          state.ocrEngine = k; store.set('ocrEngine', k);
          if (k === 'vision' && !state.visionKey) ImgOcr.askKey();
          render();
        });
      });
      engBtns.auto.title = 'PaddleOCR → при сбое Tesseract → Google Vision (если задан ключ; в автопереводе Vision не используется)';
      engBtns.paddle.title = 'PaddleOCR (Baidu) прямо в браузере, без ключей: лучшее качество на китайском. ≈27 МБ, качается один раз';
      engBtns.tesseract.title = 'Tesseract прямо в браузере, без ключей: ≈5 МБ, быстрее грузится, хуже на рекламных шрифтах';
      engBtns.vision.title = 'Google Cloud Vision: нужен ключ API (1000 картинок в месяц бесплатно)';
      Object.values(engBtns).forEach((b) => rowEng.appendChild(b));
      const rowAuto = mk('div', 'tbrub-sw');
      const tAuto = toggle(() => {
        state.imgAuto = !state.imgAuto; store.set('imgAuto', state.imgAuto);
        if (state.imgAuto) ImgAuto.start(); else ImgAuto.stop();
        render();
      });
      rowAuto.append(mk('span', '', 'Автоперевод фото на странице товара'), tAuto);
      const engStatus = mk('div', 'tbrub-sub');
      const rowCheck = mk('div', 'tbrub-row');
      const checkOut = mk('div', 'tbrub-sub');
      const bCheck = btn('Проверить движки', async () => {
        if (bCheck.disabled) return;
        bCheck.disabled = true;
        const lines = [];
        for (const k of ['paddle', 'tesseract']) {
          checkOut.textContent = lines.concat(ENGINE_NAMES[k] + ': проверяю…').join('\n');
          try {
            const t = await OcrEngines.check(k);
            lines.push(ENGINE_NAMES[k] + ': ✓ работает' + (t ? ' (прочитал «' + t + '»)' : ' (текст не прочитан)'));
          } catch (e) { lines.push(ENGINE_NAMES[k] + ': ✗ ' + String((e && e.message) || e).slice(0, 120)); }
          checkOut.textContent = lines.join('\n');
          render();
        }
        toast('Проверка движков завершена', 1500);
        bCheck.disabled = false;
      });
      bCheck.title = 'Скачать (один раз) и запустить PaddleOCR и Tesseract на тестовой надписи';
      rowCheck.append(bCheck);
      checkOut.style.whiteSpace = 'pre-line';
      const rowKey = mk('div', 'tbrub-sw');
      const keyInfo = mk('span', '', '');
      const bKey = btn('Ключ…', () => ImgOcr.askKey());
      rowKey.append(keyInfo, bKey);
      const keyHint = mk('div', 'tbrub-sub', 'Наведите на фото → «🖼 Перевод на фото». Paddle и Tesseract работают без ключей и без отправки фото на сервер; Lens и «Я» открывают фото во внешнем сервисе.');
      sImg.append(mk('div', 'tbrub-h', 'Текст на фото'), rowEng, engStatus, rowAuto, rowCheck, checkOut, rowKey, keyHint);
      sTr.append(mk('div', 'tbrub-h', 'Перевод'), rowPage, trStatus, rowSearch, rowImg);
 
      panel.append(sRate, mk('div', 'tbrub-sep'), sMode, mk('div', 'tbrub-sep'), sTr, mk('div', 'tbrub-sep'), sImg);
      pill.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; renderStatus(); });
      document.addEventListener('click', () => { panel.hidden = true; });
 
      root.append(panel, pill);
      document.body.appendChild(root);
      els = { dot, pillRate, pillTr, big, src, bAuto, bManual, bCny, bBeside, bReplace, tPage, tSearch, tImg, trStatus, panel, keyInfo,
        engBtns, tAuto, engStatus };
      render();
    }
 
    function render() {
      if (!els) return;
      const live = state.auto && state.usdtRub > 0;
      const stale = state.rubError || (state.cnyAutoOn && state.cnyError);
      els.dot.className = 'tbrub-dot' + (live ? (stale ? ' stale' : ' ok') : '');
      els.pillRate.textContent = '1 ¥ ≈ ' + fmtNum(state.rate, 2) + ' ₽';
      els.big.textContent = '1 ¥ ≈ ' + fmtNum(state.rate, 2) + ' ₽';
      if (live) {
        const t = new Date(Math.max(state.usdtRubTs, state.cnyTs)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const cny = state.cnyAutoOn && state.cnyAuto > 0 ? state.cnySrc : 'задано вручную';
        els.src.textContent = 'Rapira USDT/RUB ' + fmtNum(state.usdtRub, 2) + ' ÷ ' + fmtNum(usdtCnyEff(), 2) +
          ' ¥/USDT (' + cny + ') · ' + t + (stale ? ' · часть источников недоступна' : '');
      } else {
        els.src.textContent = state.auto ? 'Автокурс ещё не получен — используется ручной ' + fmtNum(state.manualRate, 2) : 'Ручной курс';
      }
      els.bAuto.classList.toggle('sel', state.auto && state.cnyAutoOn);
      els.bManual.classList.toggle('sel', !state.auto);
      els.bCny.classList.toggle('sel', state.auto && !state.cnyAutoOn);
      els.bBeside.classList.toggle('sel', state.mode === 'beside');
      els.bReplace.classList.toggle('sel', state.mode === 'replace');
      els.tPage.classList.toggle('on', state.pageTr);
      els.tSearch.classList.toggle('on', state.searchTr);
      els.tImg.classList.toggle('on', state.imgTr);
      els.keyInfo.textContent = 'Ключ Google Vision: ' + (state.visionKey ? 'задан ✓' : 'не задан (не обязателен)');
      Object.keys(els.engBtns).forEach((k) => els.engBtns[k].classList.toggle('sel', state.ocrEngine === k));
      els.tAuto.classList.toggle('on', state.imgAuto);
      const st = (k) => { const v = OcrEngines.status[k]; return v === 'ok' ? 'готов ✓' : v === 'loading' ? 'загрузка…' : v ? '✗ ' + v : 'не загружен'; };
      els.engStatus.textContent = 'PaddleOCR: ' + st('paddle') + ' · Tesseract: ' + st('tesseract');
      els.pillTr.classList.toggle('on', state.pageTr);
      els.pillTr.title = state.pageTr ? 'Перевод страницы включён' : 'Перевод страницы выключен';
      renderStatus();
    }
 
    function renderStatus() {
      if (!els || els.panel.hidden || statusTimer) return;
      statusTimer = setTimeout(() => {
        statusTimer = 0;
        const s = Translator.status();
        els.trStatus.textContent = !state.pageTr ? 'Выключен — страница в оригинале'
          : !s.active ? 'Запустится после загрузки страницы'
            : 'Переведено фраз: ' + s.done + (s.queue ? ' · в очереди ' + s.queue : '') + (s.errors ? ' · ошибок сети ' + s.errors : '');
      }, 300);
    }
 
    return { mount, render, renderStatus };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  9. ЗАПУСК
   * ══════════════════════════════════════════════════════════════════════ */
  addStyle(CSS);
  Search.install();                                   // перехват поиска — раньше скриптов страницы
  if (state.pageTr) {                                 // не даём встроенному переводчику браузера вмешиваться
    whenRoot(() => {
      document.documentElement.setAttribute('translate', 'no');
      document.documentElement.classList.add('notranslate');
    });
  }
 
  function boot() {
    Ui.mount();
    ImgTr.install();
    setTimeout(() => ImgAuto.start(), 1500);
    Prices.fullScan();
    Watch.start();
    syncRates(false);
    setInterval(() => { if (!document.hidden) syncRates(false); }, 60 * 1000);
    // Перевод страницы стартует после загрузки (после гидратации React), но не позже чем через 2.5 с
    if (state.pageTr) {
      let started = false;
      const go = () => { if (!started && state.pageTr) { started = true; Translator.start(); Ui.render(); } };
      if (document.readyState === 'complete') setTimeout(go, 300);
      else { window.addEventListener('load', () => setTimeout(go, 300), { once: true }); setTimeout(go, 2500); }
    }
  }
 
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
 
