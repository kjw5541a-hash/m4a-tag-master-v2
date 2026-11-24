import { useState } from 'react'
import EditScreen from './ui/EditScreen.tsx'
import QueueScreen from './ui/QueueScreen.tsx'

// 라우터 없이 선택한 곡이 있으면 편집 화면(B), 없으면 큐(A)를 보여 준다.
export default function App() {
  const [selectedId, setSelectedId] = useState<string>()
  return (
    // 노치·홈 인디케이터 영역을 피하는 여백. 아래 고정 저장 바는 자체 여백을 가진다.
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
      {selectedId ? (
        <EditScreen id={selectedId} onBack={() => setSelectedId(undefined)} />
      ) : (
        <QueueScreen onOpen={setSelectedId} />
      )}
    </div>
  )
}
