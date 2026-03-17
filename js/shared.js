function extractYouTubeId(url) {
    if (!url) return null;
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
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
