function extractYouTubeId(url) {
    if (!url) return null;
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
}

function preloadQuestionMedia(questions) {
    const seen = new Set();
    const preloadUrl = (url, type) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        if (type === 'image') {
            new Image().src = url;
        } else {
            if (extractYouTubeId(url)) return;
            fetch(url).catch(() => {});
        }
    };
    for (const q of questions) {
        for (const url of ((q.image_urls?.length) ? q.image_urls : (q.image_url ? [q.image_url] : []))) preloadUrl(url, 'image');
        for (const url of ((q.answer_image_urls?.length) ? q.answer_image_urls : (q.answer_image_url ? [q.answer_image_url] : []))) preloadUrl(url, 'image');
        for (const url of ((q.video_urls?.length) ? q.video_urls : (q.video_url ? [q.video_url] : []))) preloadUrl(url, 'video');
        for (const url of ((q.answer_video_urls?.length) ? q.answer_video_urls : (q.answer_video_url ? [q.answer_video_url] : []))) preloadUrl(url, 'video');
    }
}

function openLightbox(src) {
    const lb = document.getElementById('img-lightbox');
    document.getElementById('img-lightbox-img').src = src;
    lb.classList.remove('hidden');
}

// 動態插入 Lightbox HTML
document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('img-lightbox')) {
        document.body.insertAdjacentHTML('beforeend',
            `<div id="img-lightbox" class="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center hidden cursor-zoom-out" onclick="this.classList.add('hidden')">
                <img id="img-lightbox-img" class="max-w-[90vw] max-h-[90vh] rounded-2xl shadow-2xl object-contain" />
            </div>`
        );
    }
});
