interface MetadataProps {
  noNd?: string;
  perihal?: string;
  pengirim?: string;
  tanggal?: string;
}

/** Compact card showing naskah metadata fields */
export function Metadata({ noNd, perihal, pengirim, tanggal }: MetadataProps) {
  const hasData = noNd || perihal || pengirim || tanggal;
  if (!hasData) return null;

  return (
    <div class="metadata">
      {noNd && (
        <div class="metadata__row">
          <span class="metadata__label">No ND</span>
          <span class="metadata__value">{noNd}</span>
        </div>
      )}
      {perihal && (
        <div class="metadata__row">
          <span class="metadata__label">Perihal</span>
          <span class="metadata__value">{perihal}</span>
        </div>
      )}
      {pengirim && (
        <div class="metadata__row">
          <span class="metadata__label">Pengirim</span>
          <span class="metadata__value">{pengirim}</span>
        </div>
      )}
      {tanggal && (
        <div class="metadata__row">
          <span class="metadata__label">Tanggal</span>
          <span class="metadata__value">{tanggal}</span>
        </div>
      )}
    </div>
  );
}
