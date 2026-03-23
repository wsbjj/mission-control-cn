'use client';

import {useState, useEffect} from 'react';
import {useParams} from 'next/navigation';
import {Link, useRouter} from '@/i18n/navigation';
import {useTranslations} from 'next-intl';
import {ArrowLeft, Layers} from 'lucide-react';
import {BatchReviewList} from '@/components/autopilot/BatchReviewList';
import type {Idea} from '@/lib/types';

export default function BatchReviewPage() {
  const t = useTranslations('autopilotBatchReview');
  const {productId} = useParams<{productId: string}>();
  const router = useRouter();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadIdeas() {
      try {
        const res = await fetch(
          `/api/products/${productId}/ideas/pending?sort_by=impact_score&sort_dir=desc`
        );
        if (res.ok) {
          const data = await res.json();
          setIdeas(data);
        }
      } catch (error) {
        console.error('Failed to load pending ideas:', error);
      } finally {
        setLoading(false);
      }
    }
    loadIdeas();
  }, [productId]);

  const handleBatchComplete = () => {
    router.push(`/autopilot/${productId}/swipe`);
  };

  return (
    <div className="min-h-screen bg-mc-bg flex flex-col">
      <header className="border-b border-mc-border bg-mc-bg-secondary px-4 py-3 flex items-center gap-3">
        <Link href={`/autopilot/${productId}/swipe`} className="text-mc-text-secondary hover:text-mc-text">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <Layers className="w-5 h-5 text-mc-accent" />
        <h1 className="font-semibold text-mc-text">{t('pageTitle')}</h1>
        {!loading && (
          <span className="text-sm text-mc-text-secondary ml-2">
            {t('pendingIdeasCount', {count: ideas.length})}
          </span>
        )}
      </header>

      <main className="flex-1 flex flex-col">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-mc-text-secondary animate-pulse">{t('loadingIdeas')}</div>
          </div>
        ) : (
          <BatchReviewList productId={productId} ideas={ideas} onBatchComplete={handleBatchComplete} />
        )}
      </main>
    </div>
  );
}
