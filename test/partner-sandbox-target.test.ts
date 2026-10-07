import { describe,it,expect } from 'vitest'
import { resolveClass } from '../src/deploy-class.js'
import { validateDeployConfig } from '../src/deploy-config-validate.js'
import { resolveConfigPaths } from '../src/deploy-config-paths.js'
import type { DeployConfig } from '../src/types.js'
const target={ kind:'partner-sandbox-compose' as const,runtimeId:'partner-sandbox',host:'172.16.221.80',project:'zincapp-partner-sandbox',directory:'/srv/zincapp/partner-sandbox',manifestPath:'ops/partner-sandbox/release-target.json',ssh:{user:'zn-vault-agent'} }
const config: DeployConfig={name:'production',rootDir:'/candidate',warPath:'/candidate/api.war',port:9100,strategy:'1+R',haproxy:{hosts:['lb'],backend:'api',serverMap:{'172.16.220.55':'api-1'}},classes:[{name:'api',hosts:['172.16.220.55']},{name:'sandbox',hosts:['172.16.221.80'],target}]}
describe('explicit final sandbox target',()=>{
 it('preserves target ownership and never inherits serving fields',()=>{
  const result=resolveClass(config,config.classes![1])
  expect(result.target).toEqual(target); expect(result.blocking).toBe(true)
  expect(result.haproxy).toBeUndefined();expect(result.port).toBeUndefined();expect(result.strategy).toBeUndefined();expect(result.warPath).toBeUndefined();expect(result.tunnel).toBeUndefined()
 })
 it('accepts a separate final target without a production agent or WAR field',()=>{
  expect(validateDeployConfig(config).errors).toEqual([])
  expect(resolveConfigPaths(config).classes![1].target?.manifestPath).toBe('/candidate/ops/partner-sandbox/release-target.json')
 })
 it('rejects sandbox as a canary, mixed serving controls, or foreign ownership',()=>{
  for(const classes of [ [...config.classes!].reverse(), [config.classes![0],{...config.classes![1],haproxy:config.haproxy}], [config.classes![0],{...config.classes![1],target:{...target,host:'172.16.220.55'}}], [config.classes![0],{...config.classes![1],blocking:false}] ]) {
   expect(validateDeployConfig({...config,classes}).errors.length).toBeGreaterThan(0)
  }
 })
})

import { executeMultiClassDeployment } from '../src/multi-class-deploy.js'
it('a failed nonblocking worker cannot let the required sandbox phase run', async()=>{
 const classes=[config.classes![0],{name:'worker',hosts:['172.16.220.58'],blocking:false},config.classes![1]].map(c=>resolveClass(config,c))
 const ran:string[]=[]
 const result=await executeMultiClassDeployment(classes,async c=>{
  ran.push(c.name)
  return {ctx:{results:new Map(),aborted:false,skipped:0,successful:c.name==='worker'?0:1,failed:0,healthCheckFailed:0,workerFailed:c.name==='worker'?1:0},coverageOk:true}
 },{warn(){},info(){}})
 expect(ran).toEqual(['api','worker'])
 expect(result.classes[2].ran).toBe(false)
})
