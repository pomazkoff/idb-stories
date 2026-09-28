import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AdminSlide } from '../../api/types.js';
import { ru } from '../../i18n/ru.js';
import { truncate } from '../../lib/format.js';

export interface SlidesListProps {
  slides: AdminSlide[];
  selectedId: string | null;
  onSelect: (slideId: string) => void;
  onReorder: (slideIds: string[]) => void;
  /** Показывать ручки и кнопки перемещения (есть право редактирования). */
  editable: boolean;
  /** Идёт сохранение порядка — перемещение временно недоступно, но фокус остаётся на ручке. */
  busy: boolean;
}

function slideText(slide: AdminSlide): string {
  const first = slide.elements.find((e) => e.kind === 'text');
  return first ? truncate(first.text, 80) : ru.slides.noText;
}

function slideMeta(slide: AdminSlide): string {
  const parts: string[] = [ru.labels.slideType[slide.type]];
  if (slide.type === 'product') parts.push(ru.slides.skus(slide.productSkus.length));
  if (slide.type !== 'video') parts.push(ru.slides.seconds(slide.durationMs / 1000));
  if (slide.cta) parts.push(ru.slides.ctaShort(slide.cta.label));
  return parts.join(' · ');
}

/**
 * Список слайдов с перетаскиванием (dnd-kit). С клавиатуры: Tab до ручки, Пробел — взять,
 * стрелки — переместить, Пробел — положить; дополнительно кнопки «вверх/вниз».
 */
export function SlidesList({ slides, selectedId, onSelect, onReorder, editable, busy }: SlidesListProps) {
  const canReorder = editable && !busy && slides.length > 1;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = slides.map((s) => s.id);
  const numberOf = (id: UniqueIdentifier) => ids.indexOf(String(id)) + 1;

  const announcements: Announcements = {
    onDragStart: ({ active }) => ru.slides.dndStart(numberOf(active.id)),
    onDragOver: ({ active, over }) => (over ? ru.slides.dndOver(numberOf(active.id), numberOf(over.id)) : undefined),
    onDragEnd: ({ active, over }) => (over ? ru.slides.dndEnd(numberOf(active.id), numberOf(over.id)) : undefined),
    onDragCancel: ({ active }) => ru.slides.dndCancel(numberOf(active.id)),
  };

  const move = (from: number, to: number) => {
    if (!canReorder || to < 0 || to >= ids.length || from === to) return;
    onReorder(arrayMove(ids, from, to));
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: ru.slides.dndInstructions } }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={!canReorder}>
        <ol className="slides" aria-label={ru.slides.listLabel}>
          {slides.map((slide, index) => (
            <SortableSlide
              key={slide.id}
              slide={slide}
              number={index + 1}
              total={slides.length}
              selected={slide.id === selectedId}
              editable={editable && slides.length > 1}
              canReorder={canReorder}
              onSelect={() => onSelect(slide.id)}
              onMove={(delta) => move(index, index + delta)}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

interface SortableSlideProps {
  slide: AdminSlide;
  number: number;
  total: number;
  selected: boolean;
  editable: boolean;
  canReorder: boolean;
  onSelect: () => void;
  onMove: (delta: number) => void;
}

function SortableSlide({ slide, number, total, selected, editable, canReorder, onSelect, onMove }: SortableSlideProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
    disabled: !canReorder,
  });
  // Инлайн-стиль через React (CSSOM) совместим со строгим CSP: style-src 'self'.
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`slides__item${selected ? ' slides__item--selected' : ''}${isDragging ? ' slides__item--dragging' : ''}`}
    >
      {editable ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="slides__handle"
          {...attributes}
          {...listeners}
          aria-label={ru.slides.dragHandle(number)}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>
      ) : null}
      <button
        type="button"
        className="slides__select"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${ru.slides.select(number)}: ${slideText(slide)}. ${slideMeta(slide)}`}
      >
        <span className="slides__number">{number}</span>
        <span className="slides__body">
          <span className="slides__text">{slideText(slide)}</span>
          <span className="slides__meta">{slideMeta(slide)}</span>
        </span>
      </button>
      {editable ? (
        <span className="slides__moves">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => onMove(-1)}
            disabled={number === 1}
            aria-disabled={!canReorder || undefined}
            aria-label={ru.slides.moveUp(number)}
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => onMove(1)}
            disabled={number === total}
            aria-disabled={!canReorder || undefined}
            aria-label={ru.slides.moveDown(number)}
          >
            <span aria-hidden="true">↓</span>
          </button>
        </span>
      ) : null}
    </li>
  );
}
