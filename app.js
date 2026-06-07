document.addEventListener('DOMContentLoaded', () => {
    const btnStart = document.getElementById('btn-start-scraping');
    const consoleLogs = document.getElementById('console-logs');
    const resultsTitle = document.getElementById('results-title');
    const btnExportPdf = document.getElementById('btn-export-pdf');
    const videosGrid = document.getElementById('videos-grid');
    const tabButtons = document.querySelectorAll('.category-tab');
    
    let selectedCategory = 'humour';
    let eventSource = null;
    let currentVideos = []; // Store current videos state to allow removal

    const customHashtagContainer = document.getElementById('custom-hashtag-container');
    const inputCustomHashtag = document.getElementById('input-custom-hashtag');

    // Handle Category Tab switching
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btnStart.classList.contains('loading')) return;
            tabButtons.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');
            selectedCategory = btn.getAttribute('data-category');
            
            if (selectedCategory === 'custom') {
                customHashtagContainer.classList.remove('hidden');
            } else {
                customHashtagContainer.classList.add('hidden');
            }

            addLog(`Catégorie sélectionnée : ${btn.querySelector('.tab-label').textContent}`, 'system');
        });
    });

    btnStart.addEventListener('click', async () => {
        let customHashtag = '';
        if (selectedCategory === 'custom') {
            customHashtag = inputCustomHashtag.value.trim();
            if (!customHashtag) {
                addLog('Erreur : Veuillez saisir un hashtag personnalisé dans le champ.', 'error');
                return;
            }
        }

        btnStart.classList.add('loading');
        btnStart.disabled = true;
        consoleLogs.innerHTML = '';
        resultsTitle.classList.add('hidden');
        btnExportPdf.classList.add('hidden');
        videosGrid.innerHTML = '';
        currentVideos = [];
        addLog(`Démarrage du scraping pour "${selectedCategory === 'custom' ? '#' + customHashtag : selectedCategory}"...`, 'info');

        if (eventSource) eventSource.close();
        eventSource = new EventSource('/api/logs');

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            addLog(data.message, data.type);
            if (data.status === 'done') {
                eventSource.close();
                btnStart.classList.remove('loading');
                btnStart.disabled = false;
                addLog('Scraping terminé ! Récupération des résultats...', 'success');
                fetchResults();
            } else if (data.status === 'error') {
                eventSource.close();
                btnStart.classList.remove('loading');
                btnStart.disabled = false;
            }
        };

        eventSource.onerror = () => {
            eventSource.close();
            btnStart.classList.remove('loading');
            btnStart.disabled = false;
        };

        try {
            const response = await fetch('/api/scrape', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    category: selectedCategory,
                    customHashtag: customHashtag
                })
            });
            if (!response.ok) {
                const err = await response.json();
                addLog(`Erreur : ${err.message || 'Inconnue'}`, 'error');
                btnStart.classList.remove('loading');
                btnStart.disabled = false;
                eventSource.close();
            }
        } catch (err) {
            addLog(`Erreur de connexion : ${err.message}`, 'error');
            btnStart.classList.remove('loading');
            btnStart.disabled = false;
            eventSource.close();
        }
    });

    function addLog(message, type = 'info') {
        const logDiv = document.createElement('div');
        logDiv.className = `log-message ${type}`;
        const time = new Date().toLocaleTimeString('fr-FR');
        logDiv.innerHTML = `<span style="color:#64748b;margin-right:8px;">[${time}]</span>${message}`;
        consoleLogs.appendChild(logDiv);
        consoleLogs.scrollTop = consoleLogs.scrollHeight;
    }

    async function fetchResults() {
        try {
            const response = await fetch('/api/results');
            if (response.ok) {
                currentVideos = await response.json();
                renderVideos(currentVideos);
            } else {
                addLog('Impossible de récupérer les vidéos.', 'error');
            }
        } catch (err) {
            addLog(`Erreur : ${err.message}`, 'error');
        }
    }

    function renderVideos(videos) {
        if (!videos || videos.length === 0) {
            addLog('Aucune vidéo trouvée.', 'warning');
            return;
        }

        videosGrid.innerHTML = '';
        resultsTitle.classList.remove('hidden');
        btnExportPdf.classList.remove('hidden');

        videos.forEach((video, index) => {
            const card = document.createElement('div');
            card.className = 'video-card';

            const rank = index + 1;
            let rankSymbol = `#${rank}`;
            if (rank === 1) rankSymbol = '👑 #1';
            else if (rank === 2) rankSymbol = '🥈 #2';
            else if (rank === 3) rankSymbol = '🥉 #3';

            let creator = video.creator || 'Inconnu';
            if (video.url && !video.creator) {
                const m = video.url.match(/@([^\/]+)/);
                if (m && m[1]) creator = `@${m[1]}`;
            }

            // Date badge
            let dateStr = 'Aujourd\'hui';
            let dateBadgeClass = 'card-date-badge';
            if (video.created_at) {
                const now = Math.floor(Date.now() / 1000);
                const diff = Math.max(0, now - video.created_at);
                const hours = Math.floor(diff / 3600);
                const days = Math.floor(diff / 86400);
                if (days === 0) { dateStr = `Il y a ${hours}h`; dateBadgeClass = 'card-date-badge badge-today'; }
                else if (days === 1) { dateStr = 'Hier'; dateBadgeClass = 'card-date-badge badge-yesterday'; }
                else if (days <= 3) { dateStr = `Il y a ${days}j`; dateBadgeClass = 'card-date-badge badge-3days'; }
                else { dateStr = `Il y a ${days}j`; dateBadgeClass = 'card-date-badge badge-week'; }
            }

            // Window badge
            let windowBadge = '';
            if (video.timeWindow) {
                let icon = '📌', color = '#00c896';
                if (video.timeWindow.includes('3')) { icon = '📆'; color = '#f59e0b'; }
                else if (video.timeWindow.includes('semaine')) { icon = '🕒'; color = '#ef4444'; }
                windowBadge = `<div class="time-window-badge" style="background:${color}22;color:${color};border:1px solid ${color}44;">${icon} ${video.timeWindow}</div>`;
            }

            // Multiplier
            let multiplierHtml = '';
            if (video.multiplier && video.multiplier !== 'N/A') {
                const disp = parseFloat(video.multiplier) > 1 ? `+${video.multiplier}x` : `${video.multiplier}x`;
                multiplierHtml = `<div class="buzz-multiplier-container"><span class="buzz-multiplier-icon">🚀</span><div class="buzz-multiplier-text">Buzz <span class="buzz-multiplier-value">${disp}</span> vs les 2 dernières vidéos</div></div>`;
            }

            // TikTok embed player
            let videoId = '';
            const vidMatch = video.url.match(/\/video\/(\d+)/);
            if (vidMatch) videoId = vidMatch[1];

            const hue = (index * 40) % 360;
            let playerHtml;
            if (videoId) {
                playerHtml = `<div class="tiktok-embed-wrapper"><iframe src="https://www.tiktok.com/embed/v2/${videoId}?lang=fr" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen class="tiktok-embed-iframe"></iframe></div>`;
            } else {
                playerHtml = `<div class="card-top" style="background:linear-gradient(135deg,hsl(${hue},60%,12%),#06050b)"><div class="video-placeholder-icon">▶</div><div class="card-stats">👁️ ${video.views||'?'}</div></div>`;
            }

            card.innerHTML = `
                <div class="card-badge">${rankSymbol}</div>
                <div class="${dateBadgeClass}">📅 ${dateStr}</div>
                ${playerHtml}
                <div class="card-body">
                    <div>
                        <div class="creator-name">${creator}</div>
                        <p class="video-caption" title="${esc(video.caption||'')}">${esc(video.caption||'Pas de description')}</p>
                        ${windowBadge}
                        ${multiplierHtml}
                        <div class="video-detailed-stats">
                            <span class="stat-item">👁️ <strong>${video.views||'?'}</strong></span>
                            <span class="stat-item">❤️ <strong>${video.likes||'?'}</strong></span>
                            <span class="stat-item">💬 <strong>${video.commentsCount||'?'}</strong></span>
                            <span class="stat-item">📤 <strong>${video.shares||'?'}</strong></span>
                        </div>
                        ${video.topComments && video.topComments.length > 0 ? `<div class="top-comments"><div class="top-comments-title">💬 Top commentaires</div>${video.topComments.map(c=>`<div class="comment-item">${esc(c)}</div>`).join('')}</div>` : ''}
                    </div>
                    <div style="display:flex;gap:0.5rem;margin-top:auto;width:100%;">
                        <a href="${video.url}" target="_blank" class="card-action" style="flex-grow:1;">Ouvrir ↗</a>
                        <button class="btn-remove-video" data-index="${index}" title="Enlever de la sélection" style="background:#ef4444;color:white;border:none;border-radius:8px;padding:0.75rem;cursor:pointer;font-weight:bold;transition:all 0.2s;display:flex;align-items:center;justify-content:center;">❌</button>
                    </div>
                </div>
            `;
            videosGrid.appendChild(card);
        });

        // Add event listeners for the remove buttons
        document.querySelectorAll('.btn-remove-video').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(btn.getAttribute('data-index'));
                currentVideos.splice(idx, 1);
                addLog(`Vidéo supprimée de la sélection.`, 'warning');
                renderVideos(currentVideos);
            });
        });
    }

    // ── PDF Export with clickable links ──────────────────────────────────
    btnExportPdf.addEventListener('click', async () => {
        addLog('Génération du rapport PDF...', 'info');
        try {
            const videos = currentVideos;
            if (!videos || videos.length === 0) { addLog('Aucun résultat.', 'warning'); return; }

            const rows = videos.map((v, i) => {
                const rank = i + 1;
                const emoji = rank === 1 ? '👑' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
                const mult = v.multiplier && v.multiplier !== 'N/A' ? `${v.multiplier}x` : '—';
                return `<tr style="border-bottom:1px solid #1a1a2e;">
                    <td style="padding:8px;text-align:center;font-weight:800;color:#ffb703;">${emoji}#${rank}</td>
                    <td style="padding:8px;color:#fe0979;font-weight:600;">${esc(v.creator)}</td>
                    <td style="padding:8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(v.caption||'')}</td>
                    <td style="padding:8px;text-align:center;">${v.views||'?'}</td>
                    <td style="padding:8px;text-align:center;">${v.likes||'?'}</td>
                    <td style="padding:8px;text-align:center;">${v.commentsCount||'?'}</td>
                    <td style="padding:8px;text-align:center;">${v.shares||'?'}</td>
                    <td style="padding:8px;text-align:center;color:#ff3b93;font-weight:700;">${mult}</td>
                    <td style="padding:8px;"><a href="${v.url}" style="color:#00f2fe;text-decoration:underline;word-break:break-all;font-size:9px;">${v.url}</a></td>
                </tr>`;
            }).join('');

            const html = `<div style="background:#06050b;color:#fff;padding:25px;font-family:'Outfit',Arial,sans-serif;">
                <h1 style="font-size:22px;text-align:center;margin-bottom:4px;">📊 Bilan TikTok Buzz Tracker</h1>
                <p style="font-size:13px;text-align:center;color:#00f2fe;margin:4px 0;">${selectedCategory.toUpperCase()} | ${new Date().toLocaleDateString('fr-FR')}</p>
                <p style="font-size:10px;text-align:center;color:#9ea4c0;margin-bottom:20px;">Fenêtre : ${videos[0]?.timeWindow||'24h'} — Liens cliquables</p>
                <table style="width:100%;border-collapse:collapse;font-size:10px;color:#e2e8f0;">
                    <thead><tr style="background:rgba(0,242,254,0.1);border-bottom:2px solid #00f2fe;">
                        <th style="padding:6px;">Rang</th><th style="padding:6px;text-align:left;">Créateur</th><th style="padding:6px;text-align:left;">Description</th>
                        <th style="padding:6px;">👁️</th><th style="padding:6px;">❤️</th><th style="padding:6px;">💬</th><th style="padding:6px;">📤</th>
                        <th style="padding:6px;">Buzz</th><th style="padding:6px;text-align:left;">Lien TikTok</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <p style="margin-top:20px;font-size:9px;color:#64748b;text-align:center;">TikTok Buzz Tracker — ${new Date().toLocaleString('fr-FR')}</p>
            </div>`;

            const el = document.createElement('div');
            el.innerHTML = html;

            await html2pdf().set({
                margin: [8, 5, 8, 5],
                filename: `tiktok_buzz_${selectedCategory}_${new Date().toISOString().split('T')[0]}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true, backgroundColor: '#06050b' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
                pagebreak: { mode: ['avoid-all'] }
            }).from(el).save();

            addLog('✅ PDF téléchargé avec liens cliquables !', 'success');
        } catch (err) {
            addLog(`Erreur PDF : ${err.message}`, 'error');
        }
    });

    function esc(text) {
        return text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
    }
});
