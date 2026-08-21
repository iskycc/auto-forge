-- 同一项目中的内容寻址 JAR 在不同项目版本/测试阶段共享同一个对象。
-- 幂等范围由 case_sources 的项目层级 + sha256 唯一索引负责，对象键本身不能全局唯一。
DROP INDEX case_sources_object_key_uq;
CREATE INDEX case_sources_object_key_idx ON case_sources(object_key);
