import { useEffect, useState } from 'react'

export interface KnownCountry {
  code: string
  name: string
  active: boolean
}

/** Список стран для подписей («Ближайший запуск… страны: …»). Ошибки молча дают пустой список. */
export function useKnownCountries(): KnownCountry[] {
  const [list, setList] = useState<KnownCountry[]>([])
  useEffect(() => {
    let alive = true
    window.rw.countries
      .list()
      .then((l) => alive && setList(l.map((c) => ({ code: c.code, name: c.name, active: c.active }))))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return list
}
