import { Icon } from "../components/Icon";

/** Shown when user is not on a naskah detail page */
export function EmptyView() {
  return (
    <section class="card empty-view">
      <div class="empty-view__icon"><Icon name="file-text" /></div>
      <h2 class="empty-view__title">Belum ada naskah</h2>
      <p class="empty-view__text">
        Buka halaman detail naskah di Nadine untuk melihat ringkasan AI.
      </p>
    </section>
  );
}
