import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { evaluate } from '@mdx-js/mdx'
import * as runtime from 'react/jsx-runtime'
import { LessonView } from '@/components/LessonView'
import { lessonStageViews, mdxSections, readLessonBuild } from '@/lib/lesson-data'

export const dynamicParams = false

export function generateStaticParams() {
  return readLessonBuild()?.lessons.map(lesson => ({ lessonId: lesson.id })) ?? []
}

/** Lesson MDX is trusted repository content, compiled once at build time. */
async function renderMdx(source: string): Promise<ReactNode> {
  const { default: Content } = await evaluate(source, { ...runtime })
  return <Content />
}

export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params
  const build = readLessonBuild()
  const lesson = build?.lessons.find(item => item.id === lessonId)
  if (!build || !lesson) return <main className="centered"><p>课程尚未构建，请运行 <code>pnpm build</code>。</p></main>

  const { views, sourceFiles } = await lessonStageViews(lesson, [...build.stages, ...build.upstreamStages ?? []])
  const { intro, byStage } = mdxSections(lesson.mdx, lesson)
  const sections: Record<string, ReactNode> = {}
  for (const [stageId, source] of Object.entries(byStage)) sections[stageId] = await renderMdx(source)
  const { mdx: _mdx, ...lessonData } = lesson

  return (
    <Suspense>
      <LessonView lesson={lessonData} views={views} sourceFiles={sourceFiles} intro={await renderMdx(intro)} sections={sections} />
    </Suspense>
  )
}
