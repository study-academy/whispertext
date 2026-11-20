// The drag carries the real app bundle (main/drag-helper.js); the browser's own drag is replaced.
    document.getElementById('icon').addEventListener('dragstart', event => { event.preventDefault(); window.studymut.dragApp(); });
