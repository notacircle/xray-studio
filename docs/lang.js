/* Russian for the landing page.
 *
 * One page, one URL. English lives in the HTML as the source, so the page is complete
 * and readable before this file runs — or if it never does. Russian is applied over it
 * on request and remembered.
 *
 * Values are HTML because the sentences carry inline <code> and links; they are written
 * here and nowhere else, so nothing user-supplied reaches innerHTML.
 *
 * Product vocabulary stays in Latin — outbound, balancer names, tab names, parameter
 * names. That follows the official Russian Xray documentation, and it keeps the page
 * reading the same way as the config file and the interface it describes.
 */

const RU = {
  'title': 'Xray Studio — почему балансировщик выбрал именно этот outbound',

  'nav.why': 'Зачем',
  'nav.features': 'Возможности',
  'nav.download': 'Скачать',

  'hero.h1': 'Отслеживайте балансировщики',
  'hero.lede':
    'Xray Studio следит за балансировщиками и объясняет их поведение, имитируя сетевые ' +
    'реалии',
  'hero.download': 'Скачать',
  'hero.github': 'GitHub',
  'hero.built': 'Собрано с Xray-core · macOS · Windows · Linux',
  'hero.caption':
    'Смотрите этапы решения <code>leastLoad</code>: кандидаты, арифметика, dice, кто ' +
    'отсеян и почему.',

  'promise.1.h': 'Ничего не собирается',
  'f.lead.0':
    'Ни аналитики, ни отчётов о падениях, ни проверки обновлений, ни счётчиков ' +
    'использования. Окно работает под политикой, которая вообще не пускает его в сеть, ' +
    'а процесс за ним разговаривает только с <code>127.0.0.1</code>.',
  'promise.2.h': 'Конфиги остаются вашими',
  'f.lead.1':
    'Читаются с диска и никуда не загружаются. Единственный трафик, который создаёт ' +
    'инструмент, — тот, что описан вашим же конфигом: он запускает Xray против серверов, ' +
    'которые перечислили вы. Ради этого он и нужен.',
  'promise.3.h': 'Бесплатно, покупать нечего',
  'f.lead.2':
    'Ни платных тарифов, ни лицензионных ключей, ни аккаунта. Исходники под MPL-2.0 — ' +
    'читайте, собирайте, меняйте.',
  'promise.foot':
    'Два исключения, и оба запускаете вы. Конфиг с правилами <code>geoip:</code> или ' +
    '<code>geosite:</code> при первом запуске скачивает нужные ему файлы геоданных — по ' +
    'умолчанию с GitHub или по вашим URL — и больше никогда, пока вы не нажмёте Update. ' +
    'И AI Assistant отправляет то, что вы спросили, с вашим собственным API-ключом; пока ' +
    'ключ не введён, он не делает ничего.',

  'why.kicker': 'Зачем это нужно',
  'why.h': 'Xray не говорит, как он решил',
  'f.lead.9':
    'Его API сообщает, какой outbound балансировщик выбрал бы, и ничего о том, как он к ' +
    'этому пришёл: ни стратегии, ни кандидатов, ни оценок, ни причин отсева. Результаты ' +
    'проб, отдельные замеры RTT и совпадения правил по каждому соединению наружу не ' +
    'выставлены вообще. Когда стратегия не вернула ничего, диспетчер молча уходит в ' +
    'первый outbound вашего файла и выбрасывает текст ошибки.',
  'f.lead.10':
    'Этот инструмент запускает пропатченное ядро, которое отдаёт недостающее — причём ' +
    'через настоящий код балансировщика, а не через его копию рядом, так что объяснение ' +
    'не может разойтись с поведением, которое объясняет.',

  'f1.kicker': 'Observe',
  'f1.h': 'Каждая проба на одной оси времени',
  'f.lead.3':
    'График RTT и полоса под ним, где видна каждая проба — удачная и неудачная — по тем ' +
    'же часам, так что сбой и вызванное им переключение совпадают на глаз.',
  'pt.0':
    '<b>Отказы никогда не рисуются значениями.</b> У мёртвой пробы нет RTT; обсерватория ' +
    'хранит вместо него метку-заглушку, и если её нарисовать, все настоящие замеры ' +
    'сплющатся в линию.',
  'pt.1':
    '<b>Замеры меньше миллисекунды помечены.</b> Xray обрезает задержку до целых ' +
    'миллисекунд, поэтому быстрый сервер сообщает <code>0</code> — таблица говорит об ' +
    'этом прямо, а не делает вид, что ответ мгновенный.',
  'pt.2':
    '<b>Колонки, по которым сортирует стратегия, подсвечены.</b> Таблица объясняет ' +
    'ранжирование, а не просто показывает стену чисел.',
  'pt.3':
    '<b>Логарифмическая шкала включается сама,</b> когда одна проба намного медленнее ' +
    'остальных и иначе сплющила бы их.',

  'f2.kicker': 'Faults',
  'f2.h': 'Сделать outbound недоступным по-настоящему',
  'f.lead.4':
    'Чёрная дыра, отказ в соединении, недоступный хост, мусор вместо TLS, задержка, ' +
    'ограничение полосы, потеря пакетов. Синтезированные ошибки проверены на побайтовое ' +
    'совпадение с тем, что выдаёт ядро ОС в той же ситуации.',
  'pt.4':
    '<b>Привязка к тегу outbound, а не к адресу.</b> Два outbounds могут делить IP и порт ' +
    'сервера — пакетный фильтр физически не различит их, а тег различает.',
  'pt.5':
    '<b>Пробы и трафик идут одним путём,</b> поэтому проверки здоровья видят отказ ровно ' +
    'так же, как настоящие соединения. Именно так ведёт себя фаервол.',
  'pt.6':
    '<b>Живые соединения тоже рвутся.</b> Фаервол не ждёт вежливо, пока договорят уже ' +
    'установленные потоки.',
  'pt.7':
    '<b>Пять вещей, которые так воспроизвести нельзя, перечислены в самой панели,</b> ' +
    'рядом с правилами, а не спрятаны в сноску.',

  'f3.kicker': 'Graph и Editor',
  'f3.h': 'Править конфиг, сохраняя файл',
  'f.lead.5':
    'Кликните узел на схеме, чтобы его изменить, или правьте текст напрямую. Любая ' +
    'правка — минимальная заплатка к JSON, а не пересборка файла заново.',
  'pt.8':
    '<b>Ваши комментарии и форматирование остаются.</b> Настройки протокола, TLS, Reality ' +
    'и <code>mux</code> не тронуты: схема знает про теги и маршрутизацию, и если собирать ' +
    'файл из неё, всё остальное исчезнет.',
  'pt.9':
    '<b>Переименование тянет за собой ссылки</b> — <code>fallbackTag</code>, ' +
    '<code>outboundTag</code>, <code>balancerTag</code> у правила, — но намеренно не ' +
    'трогает селекторы балансировщиков: селектор это шаблон, а не ссылка.',
  'pt.10':
    '<b>Ничего не пишется на диск, пока вы не нажмёте «Save»,</b> и черновик сперва ' +
    'проверяется настоящим загрузчиком конфигов.',
  'pt.11':
    '<b>Наведите на любой ключ и получите документацию:</b> 360 параметров из официальной ' +
    'документации Xray, по-английски или по-русски.',

  'f4.kicker': 'What-if',
  'f4.h': 'Спросить, ничего не трогая',
  'f.lead.6':
    'Что сделал бы этот балансировщик, будь <code>maxRTT</code> равен 200 мс или умри ' +
    'этот outbound? Ответ даёт прогон настоящего кода стратегии по замороженному ' +
    'наблюдению — а не модель этого кода.',
  'pt.12':
    '<b>Результат по 1000 прогонов.</b> <code>random</code> и <code>leastLoad</code> ' +
    'заканчиваются равномерным жребием, поэтому при нескольких прошедших кандидатах ' +
    'единственного ответа нет — есть распределение.',
  'pt.13':
    '<b>Работает вообще без трафика,</b> потому что живое решение ему для ответа не нужно.',

  'f5.kicker': 'Validate',
  'f5.h': 'Конфиги, которые грузятся и ничего не делают',
  'f.lead.7':
    'Битые конфиги Xray отвергает и сам. О чём он не скажет — это про конфиг, который он ' +
    'принимает и потом не исполняет. Такие показаны как <em>silently broken</em>.',
  'pt.14':
    '<b>Ключ, который никто не читает.</b> JSON-декодер в Go молча игнорирует неизвестные ' +
    'поля, поэтому <code>"balancer"</code> вместо <code>"balancers"</code> ведёт себя ' +
    'ровно так, будто блока нет вовсе.',
  'pt.15':
    '<b>Селектор, не совпавший ни с одним outbound</b> — при загрузке это не проверяется ' +
    'никогда, потому что балансировщики создаются раньше, чем появляются outbounds.',
  'pt.16':
    '<b><code>fallbackTag</code>, указывающий в никуда,</b> из-за чего трафик тихо уходит ' +
    'через первый outbound в файле.',
  'pt.17':
    '<b>Набор известных ключей берётся из самого парсера</b> через рефлексию, поэтому он ' +
    'не может разойтись с Xray по мере его развития.',

  'f6.kicker': 'Self-check',
  'f6.h': 'Инструмент проверяет собственные утверждения',
  'f.lead.8':
    'Всё, что это приложение говорит про Xray, — утверждение о чужом коде. Эти проверки ' +
    'заново выводят те же утверждения из ответов самого ядра, чтобы ошибочное стало ' +
    'видно, а не вводило в заблуждение молча.',

  'dl.h': 'Скачать',
  'dl.sub':
    'По одному файлу на систему, на <a href="https://github.com/notacircle/xray-studio/releases">' +
    'странице релизов</a>. На Windows ставить нечего, регистрироваться негде.',
  'dl.os.0': 'macOS 14+',
  'dl.note.0': 'Открыть, перетащить в Applications. Intel и Apple Silicon в одной сборке.',
  'dl.os.1': 'Windows 10+',
  'dl.note.1': 'Портативная — распакуйте куда угодно и запускайте. Берите эту.',
  'dl.os.2': 'Windows 11 на ARM',
  'dl.note.2': 'Только ради нативной скорости на Snapdragon; сборка x64 там тоже работает.',
  'dl.os.3': 'Arch Linux',
  'dl.note.3': '<code>sudo pacman -U &lt;файл&gt;</code>. Пакет под <code>aarch64</code> тоже есть.',
  'dl.os.4': 'Любой другой Linux',
  'dl.note.4': '<code>chmod +x</code> и запускать. Без установки и без разрешения зависимостей.',
  'dl.p.0':
    '<strong>Ничего не подписано.</strong> На macOS нужно один раз снять карантин ' +
    '(<code>xattr -dr com.apple.quarantine "/Applications/Xray Studio.app"</code>), ' +
    'а Windows предупредит о неизвестном издателе. В ' +
    '<a href="https://github.com/notacircle/xray-studio/blob/main/README.ru.md#установка">README</a> ' +
    'написано, какой файл ваш, если вы не уверены, и каждый релиз несёт исходники, из ' +
    'которых собран.',
  'dl.p.1':
    '<strong>На Windows приложение не пишет ничего за пределами своей папки</strong> — ни ' +
    'ключей реестра, ни записи в списке установленных программ. Удалили папку — не ' +
    'осталось следов; скопировали на флешку — настройки поехали с вами.',

  'foot.repo': 'Репозиторий',
  'foot.releases': 'Релизы',
  'foot.issues': 'Сообщить о проблеме',
  'foot.licence':
    'Xray-core под MPL-2.0, и наложенные на него патчи тоже. Документация по параметрам ' +
    'адаптирована из <a href="https://github.com/XTLS/Xray-docs-next">XTLS/Xray-docs-next</a> ' +
    'под CC BY-SA 4.0.',
  'foot.affil': 'Проект не связан с XTLS.',
}

/* English is not a dictionary: it is whatever the HTML already said. Captured once, on
   load, so switching back restores the source rather than a second copy of it that
   could drift from the page. */
const EN = {}
const STORAGE_KEY = 'x-ray.studio.lang'

function nodes() {
  return document.querySelectorAll('[data-i18n]')
}

function apply(lang) {
  for (const el of nodes()) {
    const key = el.dataset.i18n
    if (EN[key] === undefined) EN[key] = el.innerHTML
    const next = lang === 'ru' ? RU[key] : EN[key]
    if (next !== undefined) el.innerHTML = next
  }
  document.documentElement.lang = lang
  for (const b of document.querySelectorAll('.lang button')) {
    const on = b.dataset.lang === lang
    b.classList.toggle('on', on)
    b.setAttribute('aria-pressed', String(on))
  }
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* private mode: the choice simply will not survive a reload */
  }
}

document.addEventListener('DOMContentLoaded', () => {
  for (const el of nodes()) EN[el.dataset.i18n] = el.innerHTML

  // English is the default and stays it. The browser's language is deliberately not
  // consulted: this page is an argument for downloading an unsigned binary, and a
  // reader who arrived from an English link should not have it change under them.
  let saved = null
  try {
    saved = localStorage.getItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  if (saved === 'ru') apply('ru')

  for (const b of document.querySelectorAll('.lang button')) {
    b.addEventListener('click', () => apply(b.dataset.lang))
  }
})
