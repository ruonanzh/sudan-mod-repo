/**
 * TypeBox, reduced to the shape the extensions register.
 *
 * A test calls `execute` with a plain object; it never asks TypeBox to validate one. What
 * the tests do read is the schema: `parameters.properties` names the arguments a tool takes.
 * So the builders keep the shape and skip the validation.
 */
const builder = (type) => (options = {}) => ({ type, ...options });

export const Type = {
  Object: (properties) => ({ type: "object", properties }),
  Optional: (schema) => schema,
  String: builder("string"),
  Boolean: builder("boolean"),
  Union: (anyOf) => ({ anyOf }),
  Literal: (value) => ({ const: value }),
};
