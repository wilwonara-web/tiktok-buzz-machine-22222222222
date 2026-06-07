const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Serve public folder and fallback to index.html on root
app.use(express.static(path.resolve(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Root route fallback
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global state
let latestResults = [];
let logClients = [];
let isScraping = false;

// Category to Hashtag mapping
const categoryHashtags = {
    humour: 'humour',
    cuisine: 'cuisine',
    jeuvideo: 'gamingfr',
    974: '974',
    team974: 'team974',
    fyp: 'fyp',
    twitch: 'twitch',
    youtube: 'youtube'
};

// SSE logs endpoint
app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    logClients.push(res);

    req.on('close', () => {
        logClients = logClients.filter(client => client !== res);
    });
});

// Broadcast log helper
function sendLog(message, type = 'info', status = 'running') {
    const data = JSON.stringify({ message, type, status });
    logClients.forEach(client => client.write(`data: ${data}\n\n`));
    console.log(`[SCRAPER LOG] [${type.toUpperCase()}] ${message}`);
}

// Language classification heuristic (French vs English)
function isFrench(text) {
    if (!text) return true;
    
    const cleanText = text.toLowerCase()
        .replace(/[^a-zàâäéèêëîïôöùûüç\s]/g, ' ')
        .split(/\s+/);
        
    const frenchStopwords = new Set([
        'le', 'la', 'les', 'de', 'des', 'un', 'une', 'et', 'en', 'que', 'est', 'dans', 'pour', 
        'qui', 'avec', 'sur', 'plus', 'pas', 'mais', 'nous', 'vous', 'leur', 'elle', 'elles',
        'ils', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'ce', 'cet',
        'cette', 'ces', 'je', 'tu', 'il', 'on', 'y', 'quand', 'comme', 'aussi', 'alors',
        'très', 'bien', 'tout', 'même', 'si', 'car', 'donc', 'or', 'ni', 'ne'
    ]);
    
    const englishStopwords = new Set([
        'the', 'and', 'of', 'to', 'a', 'is', 'in', 'that', 'it', 'you', 'for', 'on', 'with', 
        'as', 'at', 'by', 'an', 'this', 'was', 'are', 'be', 'have', 'or', 'your', 'my', 'me',
        'what', 'who', 'how', 'why', 'where', 'when', 'like', 'just', 'from', 'about', 'out',
        'they', 'them', 'their', 'we', 'us', 'our', 'he', 'she'
    ]);
    
    let frenchScore = 0;
    let englishScore = 0;
    
    for (const word of cleanText) {
        if (frenchStopwords.has(word)) frenchScore++;
        if (englishStopwords.has(word)) englishScore++;
    }
    
    if (/[àâäéèêëîïôöùûüç]/.test(text.toLowerCase())) {
        frenchScore += 3;
    }
    
    if (frenchScore === 0 && englishScore === 0) {
        return true;
    }
    
    return frenchScore >= englishScore;
}

// Extract timestamp from TikTok Video ID (Snowflake format)
function extractVideoTimestamp(url) {
    try {
        const matches = url.match(/\/video\/(\d+)/);
        if (matches && matches[1]) {
            const videoId = matches[1];
            const timestamp = Number(BigInt(videoId) >> 32n);
            return timestamp;
        }
    } catch (err) {
        console.error('Failed to parse video timestamp from url:', url, err);
    }
    return null;
}

// Parse human-readable views/likes/shares strings (e.g. "1.2K", "3.5M") to numbers
function parseCount(str) {
    if (!str) return 0;
    const s = String(str).toUpperCase().replace(/\s/g, '').replace(/,/g, '.');
    if (s.endsWith('M')) return parseFloat(s) * 1000000;
    if (s.endsWith('K')) return parseFloat(s) * 1000;
    if (s.endsWith('B')) return parseFloat(s) * 1000000000;
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

// Format count number back to human-readable
function formatCount(n) {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
}

// GET route to fetch the latest scraped results
app.get('/api/results', (req, res) => {
    res.json(latestResults);
});

// POST route to trigger scraping
app.post('/api/scrape', async (req, res) => {
    if (isScraping) {
        return res.status(400).json({ message: 'Scraping déjà en cours. Veuillez attendre sa complétion.' });
    }

    const { category, customHashtag } = req.body;
    
    let hashtag = categoryHashtags[category] || 'humour';
    if (category === 'custom' && customHashtag) {
        // Clean hashtag input from spacing or '#' prefixes
        hashtag = customHashtag.trim().replace(/^#+/, '').replace(/\s+/g, '');
    }

    // Categories where the 10K view threshold is disabled
    const NO_THRESHOLD_CATEGORIES = ['team974'];
    const skipThreshold = NO_THRESHOLD_CATEGORIES.includes(category);

    isScraping = true;
    res.status(202).json({ message: 'Scraping démarré.' });

    let browser = null;
    try {
        sendLog(`Lancement du navigateur Chromium en mode ANONYME (sans connexion)...`, 'info');
        
        const isProd = process.env.NODE_ENV === 'production';
        browser = await chromium.launch({
            headless: isProd ? true : false,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        });

        const context = await browser.newContext({
            viewport: null,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale: 'fr-FR',
            timezoneId: 'Europe/Paris'
        });

        const page = await context.newPage();
        
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const tagUrl = `https://www.tiktok.com/tag/${hashtag}`;
        sendLog(`Navigation vers la page du hashtag : #${hashtag}`, 'info');
        
        await page.goto(tagUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        sendLog('Page du hashtag chargée. Chargement des composants publics...', 'info');
        sendLog('Si un captcha de vérification apparaît à l\'écran, veuillez le résoudre rapidement dans la fenêtre Chromium.', 'warning');
        
        await page.waitForTimeout(5000);

        // Dynamic scroll loop until we get at least 70 video URLs (Sample size: 70)
        let scrollCount = 0;
        const maxScrolls = 30;
        let videoUrlsCount = 0;
        const TARGET_SAMPLE = 70;
        
        sendLog(`Début du défilement dynamique pour charger au moins ${TARGET_SAMPLE} vidéos...`, 'info');
        
        while (videoUrlsCount < TARGET_SAMPLE && scrollCount < maxScrolls) {
            scrollCount++;
            
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight * 1.5);
            });
            await page.waitForTimeout(2500);
            
            videoUrlsCount = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const videoUrls = links.map(l => l.href).filter(href => href && href.includes('/video/'));
                return new Set(videoUrls).size;
            });
            
            sendLog(`Défilement ${scrollCount}/${maxScrolls} : ${videoUrlsCount} vidéos chargées (cible: ${TARGET_SAMPLE})...`, 'info');
        }

        sendLog('Extraction des données des vidéos chargées...', 'info');

        const rawVideos = await page.evaluate(() => {
            const cards = [];
            // TikTok renders video links inside list/grid items
            const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
            const countRegex = /^\d+(\.\d+)?[KMBkmb]?$/;

            for (const link of links) {
                const href = link.href;
                if (!href || cards.some(c => c.url === href)) continue;

                // Walk up to find the card container (up to 8 levels)
                let container = link;
                for (let d = 0; d < 8; d++) {
                    if (!container.parentElement) break;
                    container = container.parentElement;
                    const cn = container.className || '';
                    if (cn.includes('Item') || cn.includes('Card') || cn.includes('Container') || 
                        cn.includes('Wrapper') || cn.includes('VideoItem') || cn.includes('video-feed')) {
                        break;
                    }
                }

                // --- View count ---
                let views = '0';
                
                // 1. Try TikTok data-e2e attribute (most reliable)
                const e2eViewEl = container.querySelector('[data-e2e*="video-views"], [data-e2e*="play-count"], strong[data-e2e]');
                if (e2eViewEl) {
                    const t = e2eViewEl.textContent.trim().replace(/\s/g, '');
                    if (countRegex.test(t) && t !== '0') views = t;
                }

                // 2. Try strong elements (TikTok puts counts in <strong>)
                if (views === '0') {
                    const strongs = Array.from(container.querySelectorAll('strong'));
                    for (const s of strongs) {
                        const t = s.textContent.trim().replace(/\s/g, '');
                        if (countRegex.test(t) && t !== '0') { views = t; break; }
                    }
                }

                // 3. Try any element with aria-label containing "views" or "plays"
                if (views === '0') {
                    const ariaEls = Array.from(container.querySelectorAll('[aria-label]'));
                    for (const el of ariaEls) {
                        const label = el.getAttribute('aria-label') || '';
                        const numMatch = label.match(/(\d+(?:\.\d+)?[KMBkmb]?)\s*(?:views?|plays?|vues?)/i);
                        if (numMatch) { views = numMatch[1]; break; }
                    }
                }

                // 4. Fallback: scan all text nodes for count-like strings
                if (views === '0') {
                    const allTexts = Array.from(container.querySelectorAll('span, p, div, strong'))
                        .map(el => el.textContent.trim())
                        .filter(t => t.length > 0 && t.length < 15);
                    for (const text of allTexts) {
                        const clean = text.replace(/\s/g, '');
                        if (countRegex.test(clean) && clean !== '0') { views = clean; break; }
                    }
                }

                // --- Caption ---
                let caption = '';
                const allTexts = Array.from(container.querySelectorAll('span, p, h3, h4'))
                    .map(el => el.textContent.trim())
                    .filter(t => t.length > 0);
                const captionCandidates = allTexts.filter(t =>
                    t.length > 8 &&
                    !t.includes('@') &&
                    !t.includes('http') &&
                    !countRegex.test(t.replace(/\s/g, ''))
                );
                if (captionCandidates.length > 0) {
                    caption = captionCandidates[0];
                }

                // --- Creator from URL ---
                let creator = 'Inconnu';
                const m = href.match(/@([^\/]+)/);
                if (m && m[1]) creator = `@${m[1]}`;

                cards.push({ url: href, creator, caption: caption || '', views });
            }
            return cards;
        });

        sendLog(`Analyse des dates de publication (Snowflake ID) et de la langue sur les ${rawVideos.length} vidéos trouvées...`, 'info');

        // Progressive date window fallback: 24h → 3 days → 7 days
        const DATE_WINDOWS = [
            { seconds: 24 * 60 * 60,     label: 'aujourd\'hui (24h)' },
            { seconds: 3 * 24 * 60 * 60, label: 'les 3 derniers jours' },
            { seconds: 7 * 24 * 60 * 60, label: 'la dernière semaine' }
        ];

        let filteredVideos = [];
        let skippedLanguageCount = 0;
        let activeWindowLabel = '';
        const now = Math.floor(Date.now() / 1000);

        for (const window of DATE_WINDOWS) {
            filteredVideos = [];
            let skippedDateCount = 0;
            skippedLanguageCount = 0;

            for (const video of rawVideos) {
                if (!isFrench(video.caption)) {
                    skippedLanguageCount++;
                    continue;
                }

                const createdTimestamp = extractVideoTimestamp(video.url);
                if (createdTimestamp) {
                    const ageSeconds = now - createdTimestamp;
                    if (ageSeconds > window.seconds) {
                        skippedDateCount++;
                        continue;
                    }
                    video.created_at = createdTimestamp;
                } else {
                    skippedDateCount++;
                    continue;
                }

                filteredVideos.push(video);
            }

            activeWindowLabel = window.label;

            if (filteredVideos.length > 0) {
                sendLog(`✅ Fenêtre active : ${window.label} → ${filteredVideos.length} vidéo(s) françaises trouvée(s).`, 'success');
                break; // Enough results, stop expanding
            } else {
                if (window.seconds < 7 * 24 * 60 * 60) {
                    sendLog(`⚠️ Aucune vidéo trouvée pour ${window.label}. Élargissement de la fenêtre...`, 'warning');
                } else {
                    sendLog(`❌ Aucune vidéo trouvée même sur la semaine entière.`, 'error');
                }
            }
        }

        if (skippedLanguageCount > 0) sendLog(`${skippedLanguageCount} vidéos en anglais filtrées.`, 'warning');
        sendLog(`${filteredVideos.length} vidéo(s) françaises retenues (fenêtre : ${activeWindowLabel}). Application du filtre 10K...`, 'info');

        // Sort by views descending before creator analysis
        const sortedCandidates = filteredVideos
            .map(v => ({ ...v, viewsNumeric: parseCount(v.views) }))
            .sort((a, b) => b.viewsNumeric - a.viewsNumeric);

        // ── QUALIFICATION avec fallback progressif ──────────────────────────
        // Passe 1 : critères stricts (fenêtre date + filtre 10K + français)
        // Passe 2 : si < 20 → on retire le filtre 10K (garde français + fenêtre)
        // Passe 3 : si < 20 → on accepte toutes les langues (fenêtre élargie)
        // Dans tous les cas on vise 20 vidéos.
        // ────────────────────────────────────────────────────────────────────

        sendLog('Analyse des profils créateurs pour le filtre de performance...', 'info');

        const qualifiedVideos = [];
        const creatorBaselineCache = {}; // Cache baselines to avoid re-scraping same creator
        const excludedByThreshold = []; // Videos excluded only by the 10K rule (saved for pass 2)

        // ── Helper: scrape baseline and exact views for a creator ───────────
        async function getCreatorBaselineAndViews(videoObj) {
            const creator = videoObj.creator;
            const currentVideoUrl = videoObj.url;
            
            if (creatorBaselineCache[creator] !== undefined) {
                sendLog(`Cache hit pour ${creator} (baseline: ${formatCount(creatorBaselineCache[creator].baseline)} vues)`, 'info');
                // If we cached it, retrieve exact views from cache if matched previously
                const cached = creatorBaselineCache[creator];
                if (cached.exactViews[currentVideoUrl]) {
                    videoObj.views = cached.exactViews[currentVideoUrl];
                    videoObj.viewsNumeric = parseCount(cached.exactViews[currentVideoUrl]);
                }
                return cached.baseline;
            }
            
            try {
                const creatorPage = await context.newPage();
                await creatorPage.goto(`https://www.tiktok.com/${creator}`, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await creatorPage.waitForTimeout(3000);

                const profileData = await creatorPage.evaluate((currentVideoUrl) => {
                    const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
                    const videosData = [];
                    const urls = new Set();
                    let exactViewsForCurrent = null;

                    for (const link of links) {
                        const href = link.href;
                        if (!href) continue;
                        
                        // Find views count container for this specific video
                        let container = link.closest('div[class*="Item"]') ||
                                        link.closest('div[class*="Video"]') ||
                                        link.parentElement;
                        let walker = link;
                        for (let d = 0; d < 6; d++) {
                            if (!walker.parentElement) break;
                            walker = walker.parentElement;
                            const cn = walker.className || '';
                            if (cn.includes('Item') || cn.includes('Video') || cn.includes('Card')) {
                                container = walker;
                                break;
                            }
                        }

                        const allTexts = Array.from(container.querySelectorAll('strong, span, p'))
                            .map(el => el.textContent.trim())
                            .filter(t => t.length > 0);

                        const viewRegex = /^\d+(\.\d+)?[KMB]?$/i;
                        let viewStr = null;
                        for (const text of allTexts) {
                            const clean = text.replace(/\s/g, '');
                            if (viewRegex.test(clean) && clean !== '0') { viewStr = clean; break; }
                        }

                        // If this link is the video we are checking, extract its views from the grid card
                        if (href.includes(currentVideoUrl) || currentVideoUrl.includes(href)) {
                            if (viewStr) exactViewsForCurrent = viewStr;
                        } else {
                            // Collect baseline data from OTHER videos
                            if (urls.has(href)) continue;
                            urls.add(href);
                            if (viewStr) videosData.push(viewStr);
                        }
                    }
                    return {
                        baselineViews: videosData.slice(0, 3),
                        exactViewsForCurrent
                    };
                }, currentVideoUrl);

                await creatorPage.close();

                if (profileData.exactViewsForCurrent) {
                    videoObj.views = profileData.exactViewsForCurrent;
                    videoObj.viewsNumeric = parseCount(profileData.exactViewsForCurrent);
                    sendLog(`Vues exactes trouvées sur profil pour cette vidéo : ${profileData.exactViewsForCurrent}`, 'success');
                }

                if (profileData.baselineViews.length > 0) {
                    const nums = profileData.baselineViews.map(parseCount);
                    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
                    creatorBaselineCache[creator] = {
                        baseline: avg,
                        exactViews: { [currentVideoUrl]: profileData.exactViewsForCurrent }
                    };
                    sendLog(`Baseline ${creator} : ${formatCount(avg)} vues (sur ${profileData.baselineViews.length} vidéos)`, 'info');
                    return avg;
                } else {
                    creatorBaselineCache[creator] = {
                        baseline: null,
                        exactViews: { [currentVideoUrl]: profileData.exactViewsForCurrent }
                    };
                    sendLog(`Baseline introuvable pour ${creator} → inclus par défaut`, 'warning');
                    return null;
                }
            } catch (err) {
                console.error(`Profile scraping failed for ${creator}:`, err.message);
                creatorBaselineCache[creator] = {
                    baseline: null,
                    exactViews: {}
                };
                sendLog(`Erreur profil ${creator} → inclus par défaut`, 'warning');
                return null;
            }
        }

        // ── PASSE 1 : critères stricts ───────────────────────────────────────
        sendLog('📋 Passe 1 : critères stricts (filtre 10K actif)...', 'info');
        for (let j = 0; j < sortedCandidates.length; j++) {
            if (qualifiedVideos.length >= 20) break;
            const video = sortedCandidates[j];
            sendLog(`[${j + 1}/${sortedCandidates.length}] ${video.creator} (${video.views} vues)`, 'info');

            const baseline = await getCreatorBaselineAndViews(video);
            const currentViews = video.viewsNumeric;

            if (baseline !== null) {
                const difference = currentViews - baseline;
                const multiplier = baseline > 0 ? (currentViews / baseline).toFixed(1) : 'N/A';
                video.multiplier = multiplier;

                if (!skipThreshold && difference < 10000) {
                    sendLog(`❌ EXCLU (10K) : ${video.creator} → diff ${formatCount(difference)}`, 'warning');
                    video.relaxLevel = 2; // Mark for potential use in pass 2
                    excludedByThreshold.push(video);
                    continue;
                }
                const label = skipThreshold ? ' (seuil désactivé)' : '';
                sendLog(`✅ QUALIFIÉ : ${video.creator} → ${multiplier}x${label}`, 'success');
            } else {
                video.multiplier = 'N/A';
                sendLog(`✅ QUALIFIÉ : ${video.creator} (baseline inconnue)`, 'success');
            }
            video.relaxLevel = 1;
            qualifiedVideos.push(video);
        }

        // ── PASSE 2 : on retire le filtre 10K si besoin ─────────────────────
        if (qualifiedVideos.length < 20 && !skipThreshold) {
            const needed = 20 - qualifiedVideos.length;
            sendLog(`⚠️ Passe 2 : seulement ${qualifiedVideos.length} résultats. Ajout des ${needed} meilleur(s) exclu(s) par le seuil 10K...`, 'warning');

            // Sort excluded by views descending and take what we need
            const rawExcluded = excludedByThreshold
                .sort((a, b) => b.viewsNumeric - a.viewsNumeric)
                .slice(0, needed);
                
            for (const v of rawExcluded) {
                v.relaxLevel = 2;
                await getCreatorBaselineAndViews(v);
                sendLog(`➕ Ajouté (sans seuil 10K) : ${v.creator} → ${v.views} vues`, 'info');
                qualifiedVideos.push(v);
            }
            // Re-sort the whole pool by views
            qualifiedVideos.sort((a, b) => b.viewsNumeric - a.viewsNumeric);
        }

        // ── PASSE 3 : on élargit aux vidéos non-françaises si toujours < 20 ─
        if (qualifiedVideos.length < 20) {
            const needed = 20 - qualifiedVideos.length;
            sendLog(`⚠️ Passe 3 : ${qualifiedVideos.length} résultats. Élargissement aux vidéos toutes langues pour compléter...`, 'warning');

            // Use rawVideos pool (already has all videos within the active time window regardless of language)
            const alreadyIn = new Set(qualifiedVideos.map(v => v.url));
            const now3 = Math.floor(Date.now() / 1000);
            const activeWindowSeconds = DATE_WINDOWS.find(w => w.label === activeWindowLabel)?.seconds || (7 * 24 * 3600);

            const extraCandidates = rawVideos
                .filter(v => {
                    if (alreadyIn.has(v.url)) return false;
                    const ts = extractVideoTimestamp(v.url);
                    if (!ts) return false;
                    return (now3 - ts) <= activeWindowSeconds;
                })
                .map(v => ({ ...v, viewsNumeric: parseCount(v.views), relaxLevel: 3 }))
                .sort((a, b) => b.viewsNumeric - a.viewsNumeric)
                .slice(0, needed);

            for (const v of extraCandidates) {
                v.multiplier = 'N/A';
                await getCreatorBaselineAndViews(v);
                sendLog(`➕ Ajouté (toutes langues) : ${v.creator} → ${v.views} vues`, 'info');
                qualifiedVideos.push(v);
            }
            qualifiedVideos.sort((a, b) => b.viewsNumeric - a.viewsNumeric);
        }

        // ── PASSE 4 : on prend TOUT ce qui reste si toujours < 20 ─────────
        if (qualifiedVideos.length < 20) {
            const needed = 20 - qualifiedVideos.length;
            sendLog(`🔴 Passe 4 : ${qualifiedVideos.length} résultats. Remplissage avec les ${needed} meilleures vidéos restantes (aucun filtre)...`, 'warning');

            const alreadyIn4 = new Set(qualifiedVideos.map(v => v.url));
            const fallback = rawVideos
                .filter(v => !alreadyIn4.has(v.url))
                .map(v => ({
                    ...v,
                    viewsNumeric: parseCount(v.views),
                    relaxLevel: 4,
                    multiplier: 'N/A',
                    created_at: v.created_at || extractVideoTimestamp(v.url)
                }))
                .sort((a, b) => b.viewsNumeric - a.viewsNumeric)
                .slice(0, needed);

            for (const v of fallback) {
                await getCreatorBaselineAndViews(v);
                sendLog(`➕ Ajouté (aucun filtre) : ${v.creator} → ${v.views} vues`, 'info');
                qualifiedVideos.push(v);
            }
            qualifiedVideos.sort((a, b) => b.viewsNumeric - a.viewsNumeric);
        }

        sendLog(`🏆 Total final : ${qualifiedVideos.length} vidéo(s) sélectionnée(s). Récupération des métriques détaillées...`, 'success');


        // For each qualified video, scrape individual video page for likes, shares, comments, top3 comments
        for (let k = 0; k < qualifiedVideos.length; k++) {
            const video = qualifiedVideos[k];
            sendLog(`[${k + 1}/${qualifiedVideos.length}] Récupération des détails de ${video.creator}...`, 'info');

            try {
                const videoPage = await context.newPage();
                await videoPage.goto(video.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await videoPage.waitForTimeout(4000);

                const details = await videoPage.evaluate(() => {
                    // Helper: parse count text
                    function pc(txt) {
                        if (!txt) return 0;
                        const s = txt.toUpperCase().replace(/\s/g, '').replace(/,/g, '.');
                        if (s.endsWith('M')) return parseFloat(s) * 1000000;
                        if (s.endsWith('K')) return parseFloat(s) * 1000;
                        if (s.endsWith('B')) return parseFloat(s) * 1000000000;
                        const n = parseFloat(s);
                        return isNaN(n) ? 0 : n;
                    }

                    // --- Likes ---
                    let likes = null;
                    // Try data-e2e="like-count" first, then aria-label, then span near like button
                    const likeSelectors = [
                        '[data-e2e="like-count"]',
                        '[aria-label*="like" i]',
                        'strong[data-e2e="like-count"]',
                        'button[data-e2e="like-button"] strong',
                        'button[aria-label*="like" i] strong',
                    ];
                    for (const sel of likeSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent.trim()) {
                            likes = el.textContent.trim();
                            break;
                        }
                    }

                    // --- Comments count ---
                    let comments = null;
                    const commentSelectors = [
                        '[data-e2e="comment-count"]',
                        'button[data-e2e="comment-button"] strong',
                        '[aria-label*="comment" i] strong',
                        'strong[data-e2e="comment-count"]',
                    ];
                    for (const sel of commentSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent.trim()) {
                            comments = el.textContent.trim();
                            break;
                        }
                    }

                    // --- Shares count ---
                    let shares = null;
                    const shareSelectors = [
                        '[data-e2e="share-count"]',
                        'button[data-e2e="share-button"] strong',
                        '[aria-label*="share" i] strong',
                        'strong[data-e2e="share-count"]',
                    ];
                    for (const sel of shareSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent.trim()) {
                            shares = el.textContent.trim();
                            break;
                        }
                    }

                    // Fallback: scan all <strong> elements near "like" / "comment" / "share" buttons
                    if (!likes || !comments || !shares) {
                        const strongs = Array.from(document.querySelectorAll('strong'));
                        const countRe = /^\d+(\.\d+)?[KMBkmb]?$/;
                        const counts = strongs
                            .map(s => s.textContent.trim())
                            .filter(t => countRe.test(t.replace(/\s/g, '')));
                        
                        // First 3 numeric strong elements are typically: likes, comments, shares
                        if (!likes && counts[0]) likes = counts[0];
                        if (!comments && counts[1]) comments = counts[1];
                        if (!shares && counts[2]) shares = counts[2];
                    }

                    // --- Top 3 Comments ---
                    const topComments = [];
                    
                    // Try data-e2e comment items
                    const commentEls = Array.from(document.querySelectorAll('[data-e2e="comment-level-1"], [data-e2e*="comment"] p, .comment-content, [class*="CommentText"], [class*="commentText"]'));
                    
                    for (const el of commentEls) {
                        const text = el.textContent.trim();
                        if (text && text.length > 2 && !topComments.includes(text)) {
                            topComments.push(text);
                        }
                        if (topComments.length >= 3) break;
                    }

                    // Fallback: grab first 3 <p> or <span> blocks in comment section
                    if (topComments.length < 3) {
                        const commentSection = document.querySelector('[data-e2e="comment-list"], [class*="CommentList"], [class*="commentList"]');
                        if (commentSection) {
                            const pEls = Array.from(commentSection.querySelectorAll('p, span[class*="text" i]'));
                            for (const p of pEls) {
                                const t = p.textContent.trim();
                                if (t && t.length > 5 && !topComments.includes(t)) {
                                    topComments.push(t);
                                }
                                if (topComments.length >= 3) break;
                            }
                        }
                    }

                    // --- Views/Plays ---
                    let videoViews = null;
                    const viewSelectors = [
                        '[data-e2e="play-count"]',
                        '[class*="PlayCount"]',
                        'strong[class*="video-views"]',
                    ];
                    for (const sel of viewSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent.trim()) {
                            videoViews = el.textContent.trim();
                            break;
                        }
                    }

                    return {
                        likes: likes || null,
                        comments: comments || null,
                        shares: shares || null,
                        views: videoViews || null,
                        topComments: topComments.slice(0, 3)
                    };
                });

                await videoPage.close();

                if (details.views) {
                    video.views = details.views;
                }
                video.likes = details.likes || video.views; // fallback to views if likes unavailable
                video.commentsCount = details.comments || '?';
                video.shares = details.shares || '?';
                video.topComments = details.topComments || [];

                sendLog(`✅ Métriques de ${video.creator} : ❤️ ${video.likes} | 💬 ${video.commentsCount} | 📤 ${video.shares} | ${video.topComments.length} commentaires récupérés`, 'success');

            } catch (err) {
                console.error(`Detail scraping failed for ${video.url}:`, err.message);
                video.likes = '?';
                video.commentsCount = '?';
                video.shares = '?';
                video.topComments = [];
                sendLog(`⚠️ Détails indisponibles pour ${video.creator}`, 'warning');
            }
        }

        latestResults = qualifiedVideos.map(v => ({
            url: v.url,
            creator: v.creator,
            caption: v.caption || 'Vidéo en français',
            views: v.views,
            likes: v.likes || '?',
            commentsCount: v.commentsCount || '?',
            shares: v.shares || '?',
            topComments: v.topComments || [],
            created_at: v.created_at,
            multiplier: v.multiplier || 'N/A',
            timeWindow: activeWindowLabel,
            relaxLevel: v.relaxLevel || 1
        }));

        sendLog(`🏆 Top ${latestResults.length} calculé avec succès !`, 'success');
        
        sendLog('Fermeture du navigateur...', 'info');
        await browser.close();
        browser = null;

        sendLog('Scraping terminé !', 'success', 'done');

    } catch (err) {
        sendLog(`Erreur critique : ${err.message}`, 'error', 'error');
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    } finally {
        isScraping = false;
    }
});

app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
});
